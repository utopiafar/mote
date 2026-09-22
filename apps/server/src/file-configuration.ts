import {createHash} from 'node:crypto';
import type {FileProcessingSettings,FilePolicy} from '@mote/shared';
import {effectiveFileSettings,selectFilePolicy,migrateFilePolicy,type AppliedFilePolicy} from './file-policy.js';
import type {ProcessorRegistry} from './file-processors.js';

export type FileConfiguration={revision:string;settings:FileProcessingSettings;policy?:FilePolicy};
/** Content-affecting dependencies declared by built-in transports; plugins default to all settings. */
const builtinKeys:Record<string,(keyof FileProcessingSettings)[]>={
 'audio.http':['endpoint','apiKey','allowRemote'],
 'audio.local-dialogue':['endpoint','apiKey','allowRemote','diarizationProcessor','speakerCount','semanticTurns','localModelEndpoint','localModelName','localModelApiKey'],
 'audio.diarize':['endpoint','apiKey','speakerCount'],
 'image.http':['imageEndpoint','apiKey','allowRemote'],
 'text.utf8':[],
};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v)).digest('hex');
export function processorSettingsFingerprint(id:string,settings:FileProcessingSettings,parameters:unknown){
 const keys=builtinKeys[id]??Object.keys(settings).sort() as (keyof FileProcessingSettings)[];
 return hash({parameters,settings:Object.fromEntries(keys.map(key=>[key,settings[key]]))});
}
export function fileConfiguration(saved:FileConfiguration,sourceId:string,mime:string,registry:ProcessorRegistry,prior?:AppliedFilePolicy){
 const base=saved.settings,policy=saved.policy??migrateFilePolicy(base,registry);
 const applied=prior??(saved.policy?selectFilePolicy(policy,sourceId,mime,saved.revision):undefined);
 const override=base.sourceProfiles[sourceId],processorId=applied?.profile.processorId??(override&&override!=='inherit'?override:base.typeProfiles[mime]??base.typeProfiles[mime.split('/')[0]+'/*']??({audio:base.audioProcessor,text:'text.utf8',image:base.imageProcessor} as Record<string,string>)[mime.split('/')[0]])??'archive';
 const processor=registry.list().find(p=>p.id===processorId);
 let settings=base,unavailable=false;
 try{if(applied&&processorId!=='archive')settings=effectiveFileSettings(applied,policy,base,registry);}catch{unavailable=true;}
 if(!applied&&processorId==='audio.local-dialogue')settings={...base,endpoint:base.localEndpoint,apiKey:base.localWorkerApiKey};
 const keys=builtinKeys[processorId]??Object.keys(settings).sort() as (keyof FileProcessingSettings)[];
 // Fingerprints may include credentials, but only the digest is durable/public. Global UI revision and labels are not execution inputs.
 const serviceIds=applied?[applied.profile.serviceId,applied.profile.modelServiceId].filter(Boolean):[];
 const value={enabled:base.enabled,timeoutMs:base.timeoutMs,...(mime.startsWith('audio/')?{dailyAudioMinutes:base.dailyAudioMinutes}:{}),processorId,version:processor?.version??'unavailable',unavailable,
  settings:Object.fromEntries(keys.map(key=>[key,settings[key]])),summarize:settings.summarize,
  ...(applied?{parameters:applied.profile.parameters,diarizationProcessor:applied.profile.diarizationProcessor,services:serviceIds.map(id=>{const s=policy.services.find(s=>s.id===id);return s?{id:s.id,kind:s.kind,execution:s.execution,endpoint:s.endpoint,model:s.model,apiKey:s.apiKey}:null;}),boundServices:applied.services.map(({name,...s})=>s)}:{}),
 };
 return {analysisSettings:settings,localOnly:processorId==='audio.local-dialogue',fingerprint:hash(value),receipt:{owner:'file-processing',settingsRevision:saved.revision,processorId,processorVersion:processor?.version??'unavailable',sourceId,mime,serviceIds}};
}
