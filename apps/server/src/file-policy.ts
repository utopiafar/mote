import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import { moteText } from './i18n.js';
import {filePolicySchema,fileProcessingSchema,resolveFileRule,matchesFileType,type FilePolicy,type FileProcessingSettings,type ProcessingProfile,type ProcessingService,type PolicyRule} from '@mote/shared';
import {type ProcessorRegistry,isLoopback} from './file-processors.js';
import {StoreError,sha256} from './store.js';

export function createDefaultFilePolicy(_registry:ProcessorRegistry,endpoint:string):FilePolicy{
  const profile=(processorId:string,serviceId?:string):ProcessingProfile=>({id:processorId==='archive'?'archive':`profile.${processorId}`,name:processorId,processorId,parameters:processorId==='audio.local-dialogue'?{speakerCount:null,semanticTurns:false}:{},diarizationProcessor:'audio.diarize',...(serviceId?{serviceId}:{}),summarize:false});
  return {version:1,
    services:[{id:'central-image-ocr',name:'Central OCR',kind:'image',execution:isLoopback(process.env.MOTE_MEDIA_OCR_ENDPOINT??'http://127.0.0.1:9010/ocr')?'local':'remote',endpoint:process.env.MOTE_MEDIA_OCR_ENDPOINT??'http://127.0.0.1:9010/ocr',model:''},{id:'asr-api',name:moteText("录音转写接口"),kind:'asr',execution:'local',endpoint,model:''},{id:'asr-local',name:moteText("本地录音服务"),kind:'asr',execution:'local',endpoint,model:''}],
    profiles:[{...profile('image.http','central-image-ocr'),id:'central-image',name:'Central images'},profile('audio.local-dialogue','asr-local'),profile('audio.http','asr-api'),profile('text.utf8'),profile('document.generic'),profile('archive')],
    rules:[{type:'audio/*',profileId:'profile.audio.local-dialogue'},{type:'image/*',profileId:'central-image'},{type:'text/*',profileId:'profile.text.utf8'},...DOCUMENT_MIME_TYPES.map(type=>({type,profileId:'profile.document.generic'})),{type:'*/*',profileId:'archive'}]};
}
export function publicFilePolicy(policy:FilePolicy){return {...policy,services:policy.services.map(({apiKey,...s})=>({...s,apiKeyConfigured:!!apiKey}))};}
export function parseFilePolicy(raw:unknown,previous:FilePolicy,registry:ProcessorRegistry):FilePolicy{
  const copy=structuredClone(raw) as any;
  if(Array.isArray(copy?.services))for(const s of copy.services){delete s.apiKeyConfigured;const old=previous.services.find(v=>v.id===s.id);
    if(s.apiKey===undefined&&old?.apiKey){if(s.endpoint!==old.endpoint||s.kind!==old.kind||s.execution!==old.execution)throw new StoreError(moteText("更换服务地址或类型时，请重新填写或清除密钥"),409);s.apiKey=old.apiKey;}
    if(s.apiKey===null||s.apiKey==='')delete s.apiKey;
  }
  const policy=filePolicySchema.parse(copy);
  for(const profile of policy.profiles){
    if(profile.processorId==='archive'){if(profile.serviceId||profile.modelServiceId||profile.summarize||Object.keys(profile.parameters).length)throw new StoreError(moteText("归档方案不能设置处理步骤"),400);continue;}
    const plugin=registry.list().find(p=>p.id===profile.processorId);
    // Disabled/missing deployments retain their configuration; execution blocks until restored.
    if(!plugin){if(!previous.profiles.some(p=>JSON.stringify(p)===JSON.stringify(profile)))throw new StoreError(moteText("所选处理插件不可用"),400);continue;}
    if(plugin.stage!=='extract')throw new StoreError(moteText("方案需要选择内容提取插件"),400);
    const service=policy.services.find(s=>s.id===profile.serviceId),model=policy.services.find(s=>s.id===profile.modelServiceId);
    if(service&&service.kind!==plugin.serviceKind)throw new StoreError(moteText("服务类型与处理插件不匹配"),400);
    if(model?.kind!=='model'&&profile.modelServiceId)throw new StoreError(moteText("分析步骤需要语言模型服务"),400);
    if(plugin.localOnly&&service?.execution==='remote')throw new StoreError(moteText("本地处理插件只能绑定本地服务"),400);
    if(plugin.allowSummary===false&&profile.summarize)throw new StoreError(moteText("此处理插件不支持自动摘要"),400);
    if(plugin.dialogue){
      const diarizer=registry.get(profile.diarizationProcessor);if(diarizer.stage!=='diarize')throw new StoreError(moteText("需要说话人分离插件"),400);
      if(diarizer.localOnly&&service?.execution==='remote')throw new StoreError(moteText("本地处理插件只能绑定本地服务"),400);
    }
    const definitions=plugin.parameters??[];
    for(const key of Object.keys(profile.parameters))if(!definitions.some(d=>d.key===key))throw new StoreError(moteText("插件不支持参数 {0}", key),400);
    for(const d of definitions){const v=profile.parameters[d.key];if(v===undefined){if(d.default!==undefined)profile.parameters[d.key]=d.default;continue;}if(v===null&&d.nullable)continue;
      if(typeof v!==d.type||typeof v==='number'&&(d.integer&&!Number.isInteger(v)||d.min!==undefined&&v<d.min||d.max!==undefined&&v>d.max)||typeof v==='string'&&d.options&&!d.options.includes(v))throw new StoreError(moteText("参数 {0} 的值不合法", d.label),400);
    }
  }
  for(const rule of policy.rules){const profile=policy.profiles.find(p=>p.id===rule.profileId)!;if(profile.processorId==='archive')continue;
    const plugin=registry.list().find(p=>p.id===profile.processorId);if(!plugin)continue;
    if(!acceptsType(plugin.mediaTypes,rule.type))throw new StoreError(moteText("方案「{0}」不支持类型 {1}", profile.name, rule.type),400);
  }
  return policy;
}
export function acceptsType(types:string[],pattern:string){return types.some(t=>matchesFileType(t.endsWith('/')?t+'*':t,pattern));}
export type AppliedFilePolicy={revision:string;rule:PolicyRule;profile:ProcessingProfile;services:Omit<ProcessingService,'apiKey'>[]};
export function selectFilePolicy(policy:FilePolicy,sourceId:string,mime:string,revision:string):AppliedFilePolicy{
  const rule=resolveFileRule(policy,sourceId,mime),profile=policy.profiles.find(p=>p.id===rule.profileId)!;
  return structuredClone({revision,rule,profile,services:policy.services.filter(s=>s.id===profile.serviceId||s.id===profile.modelServiceId).map(({apiKey,...s})=>s)});
}
export function effectiveFileSettings(applied:AppliedFilePolicy,policy:FilePolicy,base:FileProcessingSettings,registry:ProcessorRegistry){
  const {profile}=applied;
  const service=(id:string|undefined)=>{if(!id)return;const snapshot=applied.services.find(s=>s.id===id),live=policy.services.find(s=>s.id===id);
    if(!snapshot||!live||snapshot.endpoint!==live.endpoint||snapshot.kind!==live.kind||snapshot.execution!==live.execution||snapshot.model!==live.model)throw new StoreError(moteText("文件使用的服务已变更；请明确重新处理文件以应用新方案"),409);
    return {...snapshot,apiKey:live.apiKey};};
  const endpoint=service(profile.serviceId),model=service(profile.modelServiceId),plugin=registry.get(profile.processorId);
  if(plugin.serviceKind&&!endpoint)throw new StoreError(moteText("请为方案选择处理服务"),409);
  if(endpoint&&endpoint.kind!==plugin.serviceKind)throw new StoreError(moteText("服务类型与处理插件不匹配"),409);
  if(plugin.localOnly&&endpoint?.execution==='remote')throw new StoreError('Local processing requires local services',409);
  const settings:FileProcessingSettings={...base,apiKey:undefined,localWorkerApiKey:undefined,imageEndpoint:'',audioProcessor:profile.processorId,
    diarizationProcessor:profile.diarizationProcessor,speakerCount:typeof profile.parameters.speakerCount==='number'?profile.parameters.speakerCount:null,semanticTurns:profile.parameters.semanticTurns===true,summarize:profile.summarize,
    ...(endpoint?{endpoint:endpoint.endpoint,apiKey:endpoint.apiKey,allowRemote:endpoint.execution==='remote',...(endpoint.kind==='image'?{imageEndpoint:endpoint.endpoint}:{}),...(endpoint.execution==='local'?{localEndpoint:endpoint.endpoint,localWorkerApiKey:endpoint.apiKey}:{})}:{}),
  };
  return {...fileProcessingSchema.parse(settings),analysisModel:model};
}
