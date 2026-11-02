import {ContextToolError} from './tool-errors.js';
import {hostControlDefinitions} from './host-controls.js';
import {ToolRegistry,type ToolSnapshot} from './tools/registry.js';
import {createOfficialReadPacks,installReadPacks,type DerivedNavigationInputs,type ReadPackRegistration} from './tools/official-read-packs.js';
import type {ContextReader,QueryInput} from './types.js';

type Definition=[string,string,Record<string,Record<string,unknown>>];
const runTools=Symbol('Host run tool registry');
interface RunTools {readonly snapshot:ToolSnapshot;readonly release:()=>void;}
type PinnedInput=QueryInput&{[runTools]?:RunTools};
export function imageToolAvailable(input:QueryInput){return input.archiveImagesEnabled!==false||Boolean(input.directImages?.length);}
export function readPackFacts(input:QueryInput):DerivedNavigationInputs {
  return Object.freeze({timeZone:input.timeZone,contextTime:input.contextTime,
    defaultChangesView:input.skill==='personal-insight'?'overview':'text',
    ...(input.incrementalEvidenceIds?{incrementalEvidenceIds:Object.freeze([...input.incrementalEvidenceIds])}:{})});
}
function enabled(input:QueryInput,name:string){
  return (name!=='read_image'||imageToolAvailable(input))&&(name!=='context_evidence'||input.evidenceIds!==undefined&&Boolean(input.evidenceReadRanges?.length))&&
    (name!=='action_catalog'||input.skill==='calendar-extraction'&&Boolean(input.actionCatalog));
}
/** Standalone Host assembly still uses the same official descriptors. Optional
 * reader operations which are unavailable cannot be advertised as tools. */
function standalonePacks(input:QueryInput,reader?:ContextReader):readonly ReadPackRegistration[]{
  const signal=input.signal??new AbortController().signal;
  const descriptors=createOfficialReadPacks(readPackFacts(input)).filter(descriptor=>descriptor.requires.every(permission=>
    permission==='progress'||permission==='actionCatalog'?permission==='progress'||Boolean(input.actionCatalog):!reader||typeof reader[permission]==='function'));
  return [{descriptors,lifecycle:{signal,assertCurrent(){signal.throwIfAborted();input.assertContextAuthority?.();}}}];
}
function assemble(input:QueryInput,packs:readonly ReadPackRegistration[]):RunTools {
  const registry=new ToolRegistry();
  const release=installReadPacks(registry,packs.map(pack=>({...pack,descriptors:pack.descriptors.filter(descriptor=>enabled(input,descriptor.name))})));
  try{return {snapshot:registry.snapshot(registry.registered()),release};}catch(error){release();throw error;}
}
export function contextToolSnapshot(input:QueryInput):ToolSnapshot {
  return (input as PinnedInput)[runTools]?.snapshot??assemble(input,input.toolContributions??standalonePacks(input)).snapshot;
}
export function hasPinnedContextTools(input:QueryInput){return Boolean((input as PinnedInput)[runTools]);}
export function releaseContextTools(input:QueryInput){(input as PinnedInput)[runTools]?.release();}
/** This local symbol is copied by trusted Host spreads but never enters the
 * serialized manifest. All consumers of one run use its one pinned registry. */
export function pinContextTools(input:QueryInput,reader:ContextReader):QueryInput {
  if((input as PinnedInput)[runTools])return input;
  const packs=input.toolContributions??reader.contextTools?.(readPackFacts(input))??standalonePacks(input,reader);
  const assembly=assemble(input,packs),snapshot=assembly.snapshot.entries.map(({name,version,fingerprint})=>({name,version,fingerprint})).sort((a,b)=>a.name.localeCompare(b.name));
  try{
    if(input.contextCapabilitySnapshot&&JSON.stringify(input.contextCapabilitySnapshot)!==JSON.stringify(snapshot))throw new ContextToolError('context_capabilities_changed','The query capability manifest changed. This saved query cannot gain new capabilities on resume.','stop');
    input.onContextCapabilities?.(snapshot);
    return {...input,toolContributions:packs,contextCapabilitySnapshot:snapshot,[runTools]:assembly} as PinnedInput;
  }catch(error){assembly.release();throw error;}
}
export function registeredContextToolDefinitions(input:QueryInput):Definition[]{
  return [...contextToolSnapshot(input).entries.map(entry=>[entry.name,entry.description,entry.fields] as Definition),...hostControlDefinitions(input.hostControlChannel)];
}
export const CAPABILITY_TOOLS:[string,string,Record<string,Record<string,unknown>>][]=[
  ['capability_discover','List registered read-only special capabilities as brief metadata. Pass an exact listed name to obtain its pinned version and argument schema before capability_execute. This host catalog cannot expand scope or authorize citations.',{name:{type:'string',description:'Exact registered capability name; omit for the brief list'}}],
  ['capability_execute','Execute one previously discovered registered read-only capability. Copy its exact name/version and encode arguments as a JSON object string following the discovered schema. The host validates schema, current authority, scope and transport boundaries. No URL, RPC, shell, code or write capability is available.',{name:{type:'string',required:true},version:{type:'string',required:true},argumentsJson:{type:'string',required:true,description:'JSON object matching the discovered argument schema'}}],
];

export function contextToolDefinitions(input:QueryInput):Definition[]{
  const registered=registeredContextToolDefinitions(input);
  if(input.hostContextToolMode==='all-native'||input.evidenceIds!==undefined||input.hostRetrieval==='none'||input.skill==='working-memory')return registered;
  const native=new Set(contextToolSnapshot(input).entries.filter(entry=>entry.exposure==='native').map(entry=>entry.name));
  return [...registered.filter(([name])=>native.has(name)||name.startsWith('delegation_')),...CAPABILITY_TOOLS];
}
