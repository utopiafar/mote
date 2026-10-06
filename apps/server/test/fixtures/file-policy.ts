import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import { moteText } from '../../src/i18n.js';
import {filePolicySchema,fileProcessingSchema,resolveFileRule,matchesFileType,type FilePolicy,type FileProcessingSettings,type ProcessingProfile,type ProcessingService,type PolicyRule} from '@mote/shared';
import {type ProcessorRegistry,isLoopback} from '../../src/file-processors.js';
import {StoreError,sha256} from '../../src/store.js';

export function fixtureFilePolicy(s:FileProcessingSettings,registry:ProcessorRegistry):FilePolicy{
  const services:ProcessingService[]=[{id:'asr-api',name:moteText("录音转写接口"),kind:'asr',execution:isLoopback(s.endpoint)?'local':'remote',endpoint:s.endpoint,model:'',apiKey:s.apiKey},{id:'asr-local',name:moteText("本地录音服务"),kind:'asr',execution:'local',endpoint:s.localEndpoint,model:'',apiKey:s.localWorkerApiKey}];
  if(s.imageEndpoint)services.push({id:'image-api',name:moteText("图片提取服务"),kind:'image',execution:isLoopback(s.imageEndpoint)?'local':'remote',endpoint:s.imageEndpoint,model:'',apiKey:s.apiKey});
  const profiles:ProcessingProfile[]=[];
  const add=(processorId:string)=>{const found=profiles.find(p=>p.processorId===processorId);if(found)return found.id;
    const plugin=registry.list().find(p=>p.id===processorId),id=processorId==='archive'?'archive':`profile.${processorId.length<=90?processorId:sha256(processorId).slice(0,40)}`;
    const parameters=plugin?.dialogue?Object.fromEntries((plugin.parameters??[]).filter(p=>p.key==='speakerCount'||p.key==='semanticTurns').map(p=>[p.key,s[p.key as 'speakerCount'|'semanticTurns']])):{};
    profiles.push({id,name:processorId==='archive'?moteText("仅归档原件"):plugin?.name??processorId,processorId,parameters,diarizationProcessor:s.diarizationProcessor,
      ...(plugin?.serviceKind==='asr'?{serviceId:plugin.localOnly?'asr-local':'asr-api'}:plugin?.serviceKind==='image'&&s.imageEndpoint?{serviceId:'image-api'}:{}),summarize:plugin?.allowSummary!==false&&processorId!=='archive'&&s.summarize});return id;};
  const rules:PolicyRule[]=[{type:'audio/*',profileId:add(s.audioProcessor)},{type:'image/*',profileId:add(s.imageProcessor)},{type:'text/*',profileId:add('text.utf8')},...DOCUMENT_MIME_TYPES.map(type=>({type,profileId:add('document.generic')})),{type:'*/*',profileId:add('archive')}];add('audio.local-dialogue');add('audio.http');
  for(const [type,processor] of Object.entries(s.typeProfiles)){const rule=rules.find(r=>r.type===type);if(rule)rule.profileId=add(processor);else rules.push({type,profileId:add(processor)});}
  for(const [sourceId,processor] of Object.entries(s.sourceProfiles)){if(processor==='inherit')continue;const types=processor==='archive'?['*/*']:registry.list().find(p=>p.id===processor)?.mediaTypes??['*/*'];for(const type of types)rules.push({sourceId,type:type.endsWith('/')?type+'*':type,profileId:add(processor)});}
  return {version:1,services,profiles,rules};
}
