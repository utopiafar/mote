import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import { moteText } from './i18n.js';
import {filePolicySchema,fileProcessingSchema,resolveFileRule,matchesFileType,type FilePolicy,type FileProcessingSettings,type ProcessingProfile,type ProcessingService,type PolicyRule} from '@mote/shared';
import {type ProcessorRegistry,isLoopback} from './file-processors.js';
import {StoreError,sha256} from './store.js';
import {DEFAULT_MEDIA_OCR_ENDPOINT} from './media-configuration.js';
import {effectiveProcessorParameters} from './processor-parameters.js';
import {validateProcessingProfiles} from './file-policy-validation.js';
export {acceptsType} from './file-policy-validation.js';

export function createDefaultFilePolicy(_registry:ProcessorRegistry|undefined,endpoint:string,ocrEndpoint=DEFAULT_MEDIA_OCR_ENDPOINT):FilePolicy{
  const profile=(processorId:string,serviceId?:string):ProcessingProfile=>({id:processorId==='archive'?'archive':`profile.${processorId}`,name:processorId,processorId,parameters:processorId==='audio.local-dialogue'?{speakerCount:null,semanticTurns:false}:{},diarizationProcessor:'audio.diarize',...(serviceId?{serviceId}:{}),summarize:false});
  return {version:1,
    services:[{id:'central-image-ocr',name:'Central OCR',kind:'image',execution:isLoopback(ocrEndpoint)?'local':'remote',endpoint:ocrEndpoint,model:''},{id:'asr-api',name:moteText("录音转写接口"),kind:'asr',execution:'local',endpoint,model:''},{id:'asr-local',name:moteText("本地录音服务"),kind:'asr',execution:'local',endpoint,model:''}],
    profiles:[{...profile('image.http','central-image-ocr'),id:'central-image',name:'Central images'},profile('audio.local-dialogue','asr-local'),profile('audio.http','asr-api'),profile('text.utf8'),profile('document.generic'),profile('archive')],
    rules:[{type:'audio/*',profileId:'profile.audio.local-dialogue'},{type:'image/*',profileId:'central-image'},{type:'text/*',profileId:'profile.text.utf8'},...DOCUMENT_MIME_TYPES.map(type=>({type,profileId:'profile.document.generic'})),{type:'*/*',profileId:'archive'}]};
}
export function publicFilePolicy(policy:FilePolicy){return {...policy,services:policy.services.map(({apiKey,...s})=>({...s,apiKeyConfigured:!!apiKey}))};}
export function parseFilePolicy(raw:unknown,previous:FilePolicy,registry:ProcessorRegistry,options:{preserveCredentials?:boolean;applyParameterDefaults?:boolean}={}):FilePolicy{
  const copy=structuredClone(raw) as any;
  if(Array.isArray(copy?.services))for(const s of copy.services){delete s.apiKeyConfigured;const old=previous.services.find(v=>v.id===s.id);
    if(options.preserveCredentials!==false&&s.apiKey===undefined&&old?.apiKey){if(s.endpoint!==old.endpoint||s.kind!==old.kind||s.execution!==old.execution)throw new StoreError(moteText("更换服务地址或类型时，请重新填写或清除密钥"),409);s.apiKey=old.apiKey;}
    if(s.apiKey===null||s.apiKey==='')delete s.apiKey;
  }
  const policy=filePolicySchema.parse(copy);
  validateProcessingProfiles(policy,previous.profiles,registry,{...options,error:(message,status)=>new StoreError(message,status)});

  return policy;
}
export type AppliedFilePolicy={revision:string;rule:PolicyRule;profile:ProcessingProfile;services:Omit<ProcessingService,'apiKey'>[]};
export function selectFilePolicy(policy:FilePolicy,sourceId:string,mime:string,revision:string):AppliedFilePolicy{
  const rule=resolveFileRule(policy,sourceId,mime),profile=policy.profiles.find(p=>p.id===rule.profileId)!;
  return structuredClone({revision,rule,profile,services:policy.services.filter(s=>s.id===profile.serviceId||s.id===profile.modelServiceId).map(({apiKey,...s})=>s)});
}
export function effectiveFileSettings(applied:AppliedFilePolicy,policy:FilePolicy,base:FileProcessingSettings,registry:ProcessorRegistry){
  const plugin=registry.get(applied.profile.processorId),profile={...applied.profile,parameters:effectiveProcessorParameters(plugin,applied.profile.parameters)};
  const service=(id:string|undefined)=>{if(!id)return;const snapshot=applied.services.find(s=>s.id===id),live=policy.services.find(s=>s.id===id);
    if(!snapshot||!live||snapshot.endpoint!==live.endpoint||snapshot.kind!==live.kind||snapshot.execution!==live.execution||snapshot.model!==live.model)throw new StoreError(moteText("文件使用的服务已变更；请明确重新处理文件以应用新方案"),409);
    return {...snapshot,apiKey:live.apiKey};};
  const endpoint=service(profile.serviceId),model=service(profile.modelServiceId);
  if(plugin.serviceKind&&!endpoint)throw new StoreError(moteText("请为方案选择处理服务"),409);
  if(endpoint&&endpoint.kind!==plugin.serviceKind)throw new StoreError(moteText("服务类型与处理插件不匹配"),409);
  if(plugin.localOnly&&endpoint?.execution==='remote')throw new StoreError('Local processing requires local services',409);
  const settings:FileProcessingSettings={...base,apiKey:undefined,localWorkerApiKey:undefined,imageEndpoint:'',audioProcessor:profile.processorId,
    diarizationProcessor:profile.diarizationProcessor,speakerCount:typeof profile.parameters.speakerCount==='number'?profile.parameters.speakerCount:null,speakerMin:typeof profile.parameters.speakerMin==='number'?profile.parameters.speakerMin:null,speakerMax:typeof profile.parameters.speakerMax==='number'?profile.parameters.speakerMax:null,semanticTurns:profile.parameters.semanticTurns===true,summarize:profile.summarize,
    ...(endpoint?{endpoint:endpoint.endpoint,apiKey:endpoint.apiKey,allowRemote:endpoint.execution==='remote',...(endpoint.kind==='image'?{imageEndpoint:endpoint.endpoint}:{}),...(endpoint.execution==='local'?{localEndpoint:endpoint.endpoint,localWorkerApiKey:endpoint.apiKey}:{})}:{}),
  };
  return {...fileProcessingSchema.parse(settings),analysisModel:model};
}
