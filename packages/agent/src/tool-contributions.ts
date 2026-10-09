import {CONTEXT_TOOLS} from './context-tools.js';
import {createHash} from 'node:crypto';
import {ContextToolError} from './tool-errors.js';
import {hostControlDefinitions} from './host-controls.js';
import type {ContextRange,ContextReader,QueryInput} from './types.js';

/** Trusted host code only. Contributions are read-only, bounded metadata tools;
 * original evidence and image grants remain owned by the evidence bridge. */
export interface ContextToolContribution {
  name:string;
  version:string;
  description:string;
  fields:Record<string,Record<string,unknown>>;
  maxCharacters:number;
  parse(args:Record<string,unknown>):Record<string,unknown>;
  authorize(scope:Readonly<ContextRange>,args:Readonly<Record<string,unknown>>):boolean|Promise<boolean>;
  read(args:Readonly<Record<string,unknown>>,context:{scope:Readonly<ContextRange>;signal?:AbortSignal}):unknown|Promise<unknown>;
}
export class ContextToolRegistry {
  private entries=new Map<string,ContextToolContribution>();
  register(tool:ContextToolContribution){
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)||tool.name.startsWith('delegation_')||!tool.version||this.entries.has(tool.name)||CONTEXT_TOOLS.some(([name])=>name===tool.name)||['skill','_ready','capability_discover','capability_execute'].includes(tool.name))throw Error('Invalid or duplicate context tool');
    if(!Number.isSafeInteger(tool.maxCharacters)||tool.maxCharacters<1||tool.maxCharacters>16000)throw Error('Invalid context tool budget');
    const entry=Object.freeze({...tool,fields:structuredClone(tool.fields)});this.entries.set(tool.name,entry);
    return ()=>{if(this.entries.get(tool.name)===entry)this.entries.delete(tool.name);};
  }
  snapshot():readonly ContextToolContribution[]{
    return Object.freeze([...this.entries.values()].map(entry=>Object.freeze({...entry,fields:structuredClone(entry.fields),
      authorize:async(scope:Readonly<ContextRange>,args:Readonly<Record<string,unknown>>)=>this.entries.get(entry.name)===entry&&await entry.authorize(scope,args),
    })));
  }
}
/** A run pins schemas/versions once; authorization is still checked on every read. */
export function pinContextTools(input:QueryInput,reader:ContextReader):QueryInput{
  const pinned=input.toolContributions?input:{...input,toolContributions:reader.contextTools?.()??[]};
  const contributions=new Map((pinned.toolContributions??[]).map(tool=>[tool.name,tool]));
  const snapshot=[...CONTEXT_TOOLS,...(pinned.toolContributions??[]).map(tool=>[tool.name,tool.description,tool.fields] as const)].map(([name,description,fields])=>({name,version:contributions.get(name)?.version??'1',fingerprint:createHash('sha256').update(JSON.stringify([description,fields])).digest('hex')})).sort((a,b)=>a.name.localeCompare(b.name));
  if(input.contextCapabilitySnapshot&&JSON.stringify(input.contextCapabilitySnapshot)!==JSON.stringify(snapshot))throw new ContextToolError('context_capabilities_changed','The query capability manifest changed. This saved query cannot gain new capabilities on resume.','stop');
  input.onContextCapabilities?.(snapshot);
  return {...pinned,contextCapabilitySnapshot:snapshot};
}
export function registeredContextToolDefinitions(input:QueryInput){
  return [...CONTEXT_TOOLS,...(input.toolContributions??[]).map(tool=>[tool.name,tool.description,tool.fields] as [string,string,Record<string,Record<string,unknown>>]),...hostControlDefinitions(input.hostControlChannel)];
}

// Ordinary discovery/reading and image modalities need no catalog round trip.
// Special capabilities remain registered host code, never arbitrary RPC/URLs.
export const NATIVE_CONTEXT_TOOLS=new Set(['material_catalog','material_read','search_context','timeline','evidence','memories','read_image','progress_update']);
export const CAPABILITY_TOOLS:[string,string,Record<string,Record<string,unknown>>][]=[
  ['capability_discover','List registered read-only special capabilities as brief metadata. Pass an exact listed name to obtain its pinned version and argument schema before capability_execute. This host catalog cannot expand scope or authorize citations.',{name:{type:'string',description:'Exact registered capability name; omit for the brief list'}}],
  ['capability_execute','Execute one previously discovered registered read-only capability. Copy its exact name/version and encode arguments as a JSON object string following the discovered schema. The host validates schema, current authority, scope and the shared budgets. No URL, RPC, shell, code or write capability is available.',{name:{type:'string',required:true},version:{type:'string',required:true},argumentsJson:{type:'string',required:true,description:'JSON object matching the discovered argument schema'}}],
];
export function contextToolDefinitions(input:QueryInput){
  const registered=registeredContextToolDefinitions(input);
  // Bounded extraction retains its existing typed tools and cannot discover.
  if(input.hostContextToolMode==='all-native'||input.evidenceIds!==undefined||input.hostRetrieval==='none'||input.skill==='working-memory')return registered;
  return [...registered.filter(([name])=>NATIVE_CONTEXT_TOOLS.has(name)||name.startsWith('delegation_')),...CAPABILITY_TOOLS];
}
