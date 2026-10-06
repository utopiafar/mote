import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import {createHash} from 'node:crypto';
import type {FileProcessingSettings,FilePolicy} from '@mote/shared';
import {effectiveFileSettings,selectFilePolicy,type AppliedFilePolicy} from './file-policy.js';
import type {FileProcessor,ProcessorRegistry} from './file-processors.js';

export type FileConfiguration={revision:string;settings:FileProcessingSettings;policy:FilePolicy};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v)).digest('hex');
type Descriptor=Omit<FileProcessor,'process'>;
export function processorContract(processor:Descriptor){
 const {id,version,stage,mediaTypes,serviceKind,localOnly,allowSummary,dialogue,managedModel,dependencies,output,recipe}=processor;
 return {id,version,stage,mediaTypes,serviceKind,localOnly,allowSummary,dialogue,managedModel,dependencies,output,recipe};
}
export function processorSettingsFingerprint(processor:Descriptor,settings:FileProcessingSettings,parameters:Record<string,unknown>){
 const keys=processor.dependencies?.settings??Object.keys(settings).sort() as (keyof FileProcessingSettings)[];
 const selected=processor.dependencies?.parameters;
 return hash({contract:processorContract(processor),parameters:selected?Object.fromEntries(selected.map(key=>[key,parameters[key]])):parameters,settings:Object.fromEntries(keys.map(key=>[key,settings[key]]))});
}
export function fileConfiguration(saved:FileConfiguration,sourceId:string,mime:string,registry:ProcessorRegistry,prior?:AppliedFilePolicy){
 const base=saved.settings,policy=saved.policy;
 const applied=prior??selectFilePolicy(policy,sourceId,mime,saved.revision);
 const processorId=applied.profile.processorId;
 const processor=registry.list().find(p=>p.id===processorId);
 let settings=base,unavailable=false;
 try{if(applied&&processorId!=='archive')settings=effectiveFileSettings(applied,policy,base,registry);}catch{unavailable=true;}
 const diarizer=processor?.dialogue?registry.list().find(p=>p.id===settings.diarizationProcessor):undefined;
 if(processor?.dialogue&&!diarizer)unavailable=true;
 const dependencies=[...(processor?[processor]:[]),...(diarizer?[diarizer]:[])];
 // Fingerprints may include credentials, but only the digest is durable/public. Global UI revision and labels are not execution inputs.
 const serviceIds=applied?[applied.profile.serviceId,applied.profile.modelServiceId].filter(Boolean):[];
 const value={enabled:base.enabled,timeoutMs:base.timeoutMs,...(mime.startsWith('audio/')?{maxAudioMinutes:base.maxAudioMinutes}:{}),processorId,version:processor?.version??'unavailable',unavailable,
  dependencies:dependencies.map(p=>processorSettingsFingerprint(p,settings,p.stage==='diarize'?{speakerCount:settings.speakerCount}:applied?.profile.parameters??{})),summarize:settings.summarize,
  ...(processor?.dialogue?{diarizationProcessor:settings.diarizationProcessor,semanticTurns:settings.semanticTurns}:{}),
  ...(applied?{parameters:applied.profile.parameters,diarizationProcessor:applied.profile.diarizationProcessor,services:serviceIds.map(id=>{const s=policy.services.find(s=>s.id===id);return s?{id:s.id,kind:s.kind,execution:s.execution,endpoint:s.endpoint,model:s.model,apiKey:s.apiKey}:null;}),boundServices:applied.services.map(({name,...s})=>s)}:{}),
 };
 return {analysisSettings:settings,allowSummary:processor?.allowSummary!==false,dialogue:processor?.dialogue===true,
  managedModels:[...new Set(dependencies.flatMap(p=>p.managedModel?[p.managedModel]:[]))],fingerprint:hash(value),
  receipt:{owner:'file-processing',settingsRevision:saved.revision,processorId,processorVersion:processor?.version??'unavailable',sourceId,mime,serviceIds,processors:dependencies.map(processorContract)}};
}
