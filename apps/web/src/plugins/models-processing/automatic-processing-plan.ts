import {MODEL_FEATURES,type ModelSettingsView} from '@mote/shared/models';
import type {FileSettingsView} from '../../processing-settings-view';

export type ProcessingConnection={id:string;fingerprint:string};
export type ProcessingKind='text'|'image'|'audio'|'conversation';
export type ProcessingScope={sourceIds:string[]|null;dataKinds:ProcessingKind[]};
export type ProcessingAuthority={revision:number;state:'unapproved'|'enabled'|'paused'|'stopped';connections:ProcessingConnection[];scope:ProcessingScope};
export type ProcessingGrant={connections:ProcessingConnection[];scope:ProcessingScope};
export const processingConnectionKey=(connection:ProcessingConnection)=>connection.id+'@'+connection.fingerprint;

/** A proposal from saved configuration only. The owner still reviews and submits it.
 * Preserve the existing source scope and every still-valid approved connection. */
export function automaticProcessingPlan(authority:ProcessingAuthority,available:ProcessingConnection[],models:ModelSettingsView,media:FileSettingsView,imageEnabled:boolean,currentSources:string[]):{plan:ProcessingGrant;covered:boolean}{
 const wanted=new Set<string>();
 for(const feature of MODEL_FEATURES){
  const profile=models.profiles.find(value=>value.id===models.defaults[feature]);
  const model=models.defaultModels[feature]||profile?.settings.model;
  if(profile&&model)wanted.add('profile:'+profile.id+':'+model);
 }
 const dataKinds=new Set<ProcessingKind>(['text','conversation']);
 if(imageEnabled)dataKinds.add('image');
 if(media.settings.enabled)for(const rule of media.policy.rules){
  const profile=media.policy.profiles.find(value=>value.id===rule.profileId);
  if(!profile||profile.processorId==='archive'||!imageEnabled&&rule.type.startsWith('image/'))continue;
  if(rule.type.startsWith('audio/'))dataKinds.add('audio');
  if(profile.serviceId){
   wanted.add('media:'+profile.serviceId+':'+profile.processorId);
   if(media.processors.find(value=>value.id===profile.processorId)?.dialogue)wanted.add('media:'+profile.serviceId+':'+profile.diarizationProcessor);
  }
  if(profile.modelServiceId){
   const service=media.policy.services.find(value=>value.id===profile.modelServiceId);
   if(service?.model)wanted.add('file-service:'+service.id+':'+service.model);
  }
 }
 const valid=new Set(available.map(processingConnectionKey));
 const needed=available.filter(value=>wanted.has(value.id));
 const approved=new Set(authority.connections.map(processingConnectionKey));
 const connections=[...new Map([...authority.connections.filter(value=>valid.has(processingConnectionKey(value))),...needed].map(value=>[processingConnectionKey(value),value])).values()];
 const scope={sourceIds:authority.scope.sourceIds===null?null:authority.state==='unapproved'?[...currentSources]:[...authority.scope.sourceIds],dataKinds:[...new Set([...authority.scope.dataKinds,...dataKinds])]};
 return {plan:{connections,scope},covered:authority.connections.length>0&&authority.connections.every(value=>valid.has(processingConnectionKey(value)))&&needed.every(value=>approved.has(processingConnectionKey(value)))&&[...dataKinds].every(value=>authority.scope.dataKinds.includes(value))};
}
