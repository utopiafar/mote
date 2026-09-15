import {filePolicySchema,fileProcessingSchema,resolveFileRule,matchesFileType,type FilePolicy,type FileProcessingSettings,type ProcessingProfile,type ProcessingService,type PolicyRule} from '@mote/shared';
import {type ProcessorRegistry,isLoopback} from './file-processors.js';
import {StoreError,sha256} from './store.js';

export function migrateFilePolicy(s:FileProcessingSettings,registry:ProcessorRegistry):FilePolicy{
  const services:ProcessingService[]=[{id:'asr-api',name:'录音转写接口',kind:'asr',execution:isLoopback(s.endpoint)?'local':'remote',endpoint:s.endpoint,model:'',apiKey:s.apiKey},{id:'asr-local',name:'本地录音服务',kind:'asr',execution:'local',endpoint:s.localEndpoint,model:'',apiKey:s.localWorkerApiKey}];
  if(s.imageEndpoint)services.push({id:'image-api',name:'图片提取服务',kind:'image',execution:isLoopback(s.imageEndpoint)?'local':'remote',endpoint:s.imageEndpoint,model:''});
  if(s.localModelName)services.push({id:'model-local',name:'本地语言模型',kind:'model',execution:'local',endpoint:s.localModelEndpoint,model:s.localModelName,apiKey:s.localModelApiKey});
  const profiles:ProcessingProfile[]=[];
  const add=(processorId:string)=>{const found=profiles.find(p=>p.processorId===processorId);if(found)return found.id;
    const local=processorId==='audio.local-dialogue',plugin=registry.list().find(p=>p.id===processorId),id=processorId==='archive'?'archive':`profile.${processorId.length<=90?processorId:sha256(processorId).slice(0,40)}`;
    profiles.push({id,name:processorId==='archive'?'仅归档原件':plugin?.name??processorId,processorId,parameters:local?{speakerCount:s.speakerCount,semanticTurns:s.semanticTurns}:{},diarizationProcessor:s.diarizationProcessor,
      ...(plugin?.serviceKind==='asr'?{serviceId:local?'asr-local':'asr-api'}:plugin?.serviceKind==='image'&&s.imageEndpoint?{serviceId:'image-api'}:{}),...(local&&s.localModelName?{modelServiceId:'model-local'}:{}),summarize:!local&&processorId!=='archive'&&s.summarize});return id;};
  const rules:PolicyRule[]=[{type:'audio/*',profileId:add(s.audioProcessor)},{type:'image/*',profileId:add(s.imageProcessor)},{type:'text/*',profileId:add('text.utf8')},{type:'application/pdf',profileId:add('archive')},{type:'*/*',profileId:add('archive')}];add('audio.local-dialogue');
  for(const [type,processor] of Object.entries(s.typeProfiles)){const rule=rules.find(r=>r.type===type);if(rule)rule.profileId=add(processor);else rules.push({type,profileId:add(processor)});}
  for(const [sourceId,processor] of Object.entries(s.sourceProfiles)){if(processor==='inherit')continue;const types=processor==='archive'?['*/*']:registry.list().find(p=>p.id===processor)?.mediaTypes??['*/*'];for(const type of types)rules.push({sourceId,type:type.endsWith('/')?type+'*':type,profileId:add(processor)});}
  return {version:1,services,profiles,rules};
}
export function publicFilePolicy(policy:FilePolicy){return {...policy,services:policy.services.map(({apiKey,...s})=>({...s,apiKeyConfigured:!!apiKey}))};}
export function parseFilePolicy(raw:unknown,previous:FilePolicy,registry:ProcessorRegistry):FilePolicy{
  const copy=structuredClone(raw) as any;
  if(Array.isArray(copy?.services))for(const s of copy.services){delete s.apiKeyConfigured;const old=previous.services.find(v=>v.id===s.id);
    if(s.apiKey===undefined&&old?.apiKey){if(s.endpoint!==old.endpoint||s.kind!==old.kind||s.execution!==old.execution)throw new StoreError('更换服务地址或类型时，请重新填写或清除密钥',409);s.apiKey=old.apiKey;}
    if(s.apiKey===null||s.apiKey==='')delete s.apiKey;
  }
  const policy=filePolicySchema.parse(copy);
  for(const profile of policy.profiles){
    if(profile.processorId==='archive'){if(profile.serviceId||profile.modelServiceId||profile.summarize||Object.keys(profile.parameters).length)throw new StoreError('归档方案不能设置处理步骤',400);continue;}
    const plugin=registry.list().find(p=>p.id===profile.processorId);
    // Disabled/missing deployments retain their configuration; execution blocks until restored.
    if(!plugin){if(!previous.profiles.some(p=>JSON.stringify(p)===JSON.stringify(profile)))throw new StoreError('所选处理插件不可用',400);continue;}
    if(plugin.stage!=='extract')throw new StoreError('方案需要选择内容提取插件',400);
    const service=policy.services.find(s=>s.id===profile.serviceId),model=policy.services.find(s=>s.id===profile.modelServiceId);
    if(service&&service.kind!==plugin.serviceKind)throw new StoreError('服务类型与处理插件不匹配',400);
    if(model?.kind!=='model'&&profile.modelServiceId)throw new StoreError('分析步骤需要语言模型服务',400);
    if(profile.processorId==='audio.local-dialogue'){
      if(service?.execution==='remote'||model?.execution==='remote'||profile.summarize)throw new StoreError('本地多人录音仅使用本地服务，自动摘要请另行配置处理插件',400);
      const diarizer=registry.get(profile.diarizationProcessor);if(diarizer.stage!=='diarize'||!diarizer.localOnly)throw new StoreError('需要本地说话人分离插件',400);
    }
    const definitions=plugin.parameters??[];
    for(const key of Object.keys(profile.parameters))if(!definitions.some(d=>d.key===key))throw new StoreError(`插件不支持参数 ${key}`,400);
    for(const d of definitions){const v=profile.parameters[d.key];if(v===undefined){if(d.default!==undefined)profile.parameters[d.key]=d.default;continue;}if(v===null&&d.nullable)continue;
      if(typeof v!==d.type||typeof v==='number'&&(d.integer&&!Number.isInteger(v)||d.min!==undefined&&v<d.min||d.max!==undefined&&v>d.max)||typeof v==='string'&&d.options&&!d.options.includes(v))throw new StoreError(`参数 ${d.label} 的值不合法`,400);
    }
  }
  for(const rule of policy.rules){const profile=policy.profiles.find(p=>p.id===rule.profileId)!;if(profile.processorId==='archive')continue;
    const plugin=registry.list().find(p=>p.id===profile.processorId);if(!plugin)continue;
    if(!acceptsType(plugin.mediaTypes,rule.type))throw new StoreError(`方案「${profile.name}」不支持类型 ${rule.type}`,400);
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
    if(!snapshot||!live||snapshot.endpoint!==live.endpoint||snapshot.kind!==live.kind||snapshot.execution!==live.execution||snapshot.model!==live.model)throw new StoreError('文件使用的服务已变更；请明确重新处理文件以应用新方案',409);
    return {...snapshot,apiKey:live.apiKey};};
  const endpoint=service(profile.serviceId),model=service(profile.modelServiceId),plugin=registry.get(profile.processorId);
  if(plugin.serviceKind&&!endpoint)throw new StoreError('请为方案选择处理服务',409);
  const settings:FileProcessingSettings={...base,apiKey:undefined,localWorkerApiKey:undefined,localModelApiKey:undefined,localModelName:'',imageEndpoint:'',audioProcessor:profile.processorId,
    diarizationProcessor:profile.diarizationProcessor,speakerCount:typeof profile.parameters.speakerCount==='number'?profile.parameters.speakerCount:null,semanticTurns:profile.parameters.semanticTurns===true,summarize:profile.summarize,
    ...(endpoint?{endpoint:endpoint.endpoint,apiKey:endpoint.apiKey,allowRemote:endpoint.execution==='remote',...(endpoint.kind==='image'?{imageEndpoint:endpoint.endpoint}:{}),...(endpoint.execution==='local'?{localEndpoint:endpoint.endpoint,localWorkerApiKey:endpoint.apiKey}:{})}:{}),
    ...(model?.execution==='local'?{localModelEndpoint:model.endpoint,localModelName:model.model,localModelApiKey:model.apiKey}:{}),
  };
  return {...fileProcessingSchema.parse(settings),analysisModel:model};
}
