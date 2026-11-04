import type {HarnessNotification} from '@deepseek-ai/dsh-sdk-client';
import type {ImportHostMedia,ImportReviewDecision,TokenUsage} from '@mote/shared';
import {ImportTaskContractError,importSkillDescriptor,importTaskDescriptor,resolveImportRecordsPath} from '../tasks/import.js';
import {AgentResponseError,type AgentOptions} from '../types.js';

/** One writable import execution, shared by every provider transport. The Host
 * owns the workspace and manifest validation; an implementation only returns a
 * bounded preview candidate for that validation. */
export interface ImportCapability {
  prepare(input:ImportAgentInput,observer?:ImportAgentObserver,onUsage?:(usage:TokenUsage)=>void):Promise<ImportAgentResult>;
  close():Promise<void>;
}

export type ImportAgentInput={language?:import('@mote/shared/i18n').Locale;workspace:string;inputPaths:string[];hostMedia?:ImportHostMedia[];instruction:string;helperPath:string;manifestSchema:unknown;schemaPath?:string;previous?:{summary:string;error?:string}};
export type ImportAgentResult={summary:string;recordsPath?:string;warnings?:string[];reviewDecision?:ImportReviewDecision};
export type ImportAgentObserver=(notification:HarnessNotification)=>void;
export type ImportAgentLaunch=(input:{workspace:string;runtimeRoot:string})=>Promise<{dshBin:string}>;

export const IMPORT_CAPABILITY_API_VERSION='1' as const;
const idPattern=/^[a-z][a-z0-9-]{0,63}$/,versionPattern=/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/,protocolPattern=/^[a-z][a-z0-9-]{0,63}$/;
const previewKeys=new Set(['summary','recordsPath','warnings','reviewDecision']),reviewKeys=new Set(['confidence','ambiguous','reason']);
const previewLimit=64000;

export type ImportCapabilityErrorCode='invalid_import_capability'|'duplicate_import_capability'|'unknown_import_capability';
export class ImportCapabilityError extends Error {
  readonly name='ImportCapabilityError';
  constructor(readonly code:ImportCapabilityErrorCode,message:string){super(message);}
}

function plainRecord(value:unknown):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

/** Validated, frozen transport contribution. `protocols` is the explicit
 * Host configuration surface; no input text or model output selects it. */
export interface ImportCapabilityDescriptor {
  readonly apiVersion:typeof IMPORT_CAPABILITY_API_VERSION;
  readonly id:string;
  readonly version:string;
  readonly protocols:readonly string[];
  readonly create:(options:Omit<AgentOptions,'reader'>,prepareLaunch?:ImportAgentLaunch)=>ImportCapability;
  readonly dispose?:()=>void|Promise<void>;
}

export function defineImportCapabilityDescriptor(input:ImportCapabilityDescriptor):ImportCapabilityDescriptor {
  const value=input as unknown;
  if(!plainRecord(value)||value.apiVersion!==IMPORT_CAPABILITY_API_VERSION)throw new ImportCapabilityError('invalid_import_capability','Import capability apiVersion must be the exact string "1".');
  if(typeof value.id!=='string'||!idPattern.test(value.id))throw new ImportCapabilityError('invalid_import_capability','Import capability id must be a bounded lowercase identifier.');
  if(typeof value.version!=='string'||!versionPattern.test(value.version))throw new ImportCapabilityError('invalid_import_capability','Import capability version must be a bounded exact version string.');
  const protocols=value.protocols;
  if(!Array.isArray(protocols)||!protocols.length||protocols.some(protocol=>typeof protocol!=='string'||!protocolPattern.test(protocol)))throw new ImportCapabilityError('invalid_import_capability','Import capability protocols must be a non-empty list of bounded lowercase protocol identifiers.');
  if(new Set(protocols).size!==protocols.length)throw new ImportCapabilityError('invalid_import_capability','Import capability protocols must not repeat.');
  if(typeof value.create!=='function')throw new ImportCapabilityError('invalid_import_capability','Import capability requires a create entry.');
  if(value.dispose!==undefined&&typeof value.dispose!=='function')throw new ImportCapabilityError('invalid_import_capability','Import capability dispose must be a function.');
  return Object.freeze({
    apiVersion:IMPORT_CAPABILITY_API_VERSION,id:value.id,version:value.version,
    protocols:Object.freeze([...protocols]),create:value.create as ImportCapabilityDescriptor['create'],
    ...(value.dispose?{dispose:value.dispose as ()=>void|Promise<void>}:{}),
  });
}

/** Versioned import transport contributions. Registration is atomic and the
 * returned disposer retires exactly the installed identities and protocols. */
export class ImportCapabilityRegistry {
  private readonly descriptors=new Map<string,ImportCapabilityDescriptor>();
  private readonly protocols=new Map<string,string>();

  register(input:ImportCapabilityDescriptor):()=>void|Promise<void>{
    const descriptor=defineImportCapabilityDescriptor(input);
    if(this.descriptors.has(descriptor.id))throw new ImportCapabilityError('duplicate_import_capability',`Import capability id is already registered: ${descriptor.id}`);
    const conflicts=descriptor.protocols.filter(protocol=>this.protocols.has(protocol));
    if(conflicts.length)throw new ImportCapabilityError('duplicate_import_capability',`Import protocol is already registered: ${conflicts.join(', ')}`);
    this.descriptors.set(descriptor.id,descriptor);
    for(const protocol of descriptor.protocols)this.protocols.set(protocol,descriptor.id);
    let disposed=false;
    return ()=>{
      if(disposed)return;
      disposed=true;
      if(this.descriptors.get(descriptor.id)===descriptor)this.descriptors.delete(descriptor.id);
      for(const protocol of descriptor.protocols)if(this.protocols.get(protocol)===descriptor.id)this.protocols.delete(protocol);
      return descriptor.dispose?.();
    };
  }

  descriptor(protocol:string):ImportCapabilityDescriptor {
    const id=this.protocols.get(protocol),descriptor=id===undefined?undefined:this.descriptors.get(id);
    if(!descriptor)throw new ImportCapabilityError('unknown_import_capability',`No import capability is registered for protocol: ${protocol}`);
    return descriptor;
  }

  create(options:Omit<AgentOptions,'reader'>,prepareLaunch?:ImportAgentLaunch):ImportCapability {
    return this.descriptor(options.protocol??'deepseek').create(options,prepareLaunch);
  }
}

/** The complete request contract sent to either transport. Prompt fields never
 * grant workspace or archive access; the Host selects those per capability. */
export function importRequestPayload(input:ImportAgentInput):string{
  return JSON.stringify({...input,language:input.language??'zh-CN',languageInstruction:'Use the selected language for summaries, warnings and generated prose; preserve original quotes and field keys.',requiredSkill:importSkillDescriptor.id,taskId:importTaskDescriptor.id,taskVersion:importTaskDescriptor.version,importedAt:new Date().toISOString(),nodeExecutable:process.execPath});
}

/** Bounded same-session correction shared by every import transport. */
export function importRepairPrompt(validationError:string):string{
  return JSON.stringify({instruction:'Your final import response could not be accepted. Using only the analysis already completed in this session, return ONLY one JSON object with summary (a string in the selected language), optional recordsPath (a string), optional warnings (an array of strings), and optional reviewDecision ({confidence:"high"|"low"|"unknown",ambiguous:boolean,reason:string}). Report high only when the mapping has no unresolved ambiguity. Do not include Markdown fences or any text outside JSON. Do not repeat analysis, run tools, rewrite files, or claim an artifact exists unless it was actually produced. Preserve any reported limitations. The host independently validates the manifest and decides whether review is required.',validationError});
}

/** Accept exactly the preview shape the Host validates. A candidate outside
 * the import workspace, with unknown fields, or with an invalid review decision
 * is a bounded formatting failure, never a usable manifest path. */
export function parseImportPreview(text:string,workspace:string):ImportAgentResult{
  if(typeof text!=='string'||text.length>previewLimit)throw new AgentResponseError('Import response exceeds its limit');
  let value:unknown;
  try{value=JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new AgentResponseError('Import response is not valid JSON');}
  if(!plainRecord(value)||Object.keys(value).some(key=>!previewKeys.has(key)))throw new AgentResponseError('Import response has an invalid shape');
  const summary=value.summary,recordsPath=value.recordsPath,warnings=value.warnings,decision=value.reviewDecision;
  if(typeof summary!=='string'||summary.length>20000)throw new AgentResponseError('Import response has an invalid summary');
  if(recordsPath!==undefined&&recordsPath!==null&&(typeof recordsPath!=='string'||recordsPath.length>4000))throw new AgentResponseError('Import response has an invalid records path');
  if(warnings!==undefined&&(!Array.isArray(warnings)||warnings.length>200||warnings.some(warning=>typeof warning!=='string'||warning.length>2000)))throw new AgentResponseError('Import response has invalid warnings');
  let reviewDecision:ImportReviewDecision|undefined;
  if(decision!==undefined&&decision!==null){
    if(!plainRecord(decision)||Object.keys(decision).some(key=>!reviewKeys.has(key))||!['high','low','unknown'].includes(decision.confidence as string)||typeof decision.ambiguous!=='boolean'||(decision.reason!==undefined&&(typeof decision.reason!=='string'||!decision.reason.trim()||decision.reason.length>1000)))throw new AgentResponseError('Import response has an invalid review decision');
    reviewDecision={confidence:decision.confidence as ImportReviewDecision['confidence'],ambiguous:decision.ambiguous,...(decision.reason!==undefined?{reason:decision.reason as string}:{})};
  }
  try{resolveImportRecordsPath(workspace,recordsPath??undefined);}catch(error){if(error instanceof ImportTaskContractError)throw new AgentResponseError(error.message);throw error;}
  return {summary,...(recordsPath!=null?{recordsPath}:{}),...(warnings!==undefined?{warnings:[...warnings as string[]]}:{}),...(reviewDecision?{reviewDecision}:{})};
}
