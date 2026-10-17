import {matchesFileType,type FilePolicy,type ProcessingProfile,type ProcessingService,fileProcessingSchema} from '@mote/shared';
import type {ProcessorRegistry} from './file-processors.js';
import {StoreError} from './execution-storage.js';
import {moteText} from './i18n.js';

/** The original credential-free processor/rule validation is shared by the
 * scoped reference graph. Transport locality is checked when a full M04
 * reference is hydrated, never inferred from a display service name. */
export function validateProcessingProfiles(policy:Pick<FilePolicy,'profiles'|'rules'>&{services:Array<Pick<ProcessingService,'id'|'kind'>&{execution?:ProcessingService['execution']}>},previousProfiles:ProcessingProfile[],registry:ProcessorRegistry,options:{applyParameterDefaults?:boolean;error?:(message:string,status:number)=>Error}={}){
  const failure=options.error??((message:string,status:number)=>new StoreError(message,status));
  for(const profile of policy.profiles){
    if(profile.processorId==='archive'){if(profile.serviceId||profile.modelServiceId||profile.summarize||Object.keys(profile.parameters).length)throw failure(moteText("归档方案不能设置处理步骤"),400);continue;}
    const plugin=registry.list().find(p=>p.id===profile.processorId);
    // Disabled/missing deployments retain their configuration; execution blocks until restored.
    if(!plugin){if(!previousProfiles.some(p=>JSON.stringify(p)===JSON.stringify(profile)))throw failure(moteText("所选处理插件不可用"),400);continue;}
    if(plugin.stage!=='extract')throw failure(moteText("方案需要选择内容提取插件"),400);
    const service=policy.services.find(s=>s.id===profile.serviceId),model=policy.services.find(s=>s.id===profile.modelServiceId);
    if(service&&service.kind!==plugin.serviceKind)throw failure(moteText("服务类型与处理插件不匹配"),400);
    if(model?.kind!=='model'&&profile.modelServiceId)throw failure(moteText("分析步骤需要语言模型服务"),400);
    if(plugin.localOnly&&service?.execution==='remote')throw failure(moteText("本地处理插件只能绑定本地服务"),400);
    if(plugin.allowSummary===false&&profile.summarize)throw failure(moteText("此处理插件不支持自动摘要"),400);
    if(plugin.dialogue){
      const diarizer=registry.get(profile.diarizationProcessor);if(diarizer.stage!=='diarize')throw failure(moteText("需要说话人分离插件"),400);
      if(diarizer.localOnly&&service?.execution==='remote')throw failure(moteText("本地处理插件只能绑定本地服务"),400);
    }
    const definitions=plugin.parameters??[];
    for(const key of Object.keys(profile.parameters))if(!definitions.some(d=>d.key===key))throw failure(moteText("插件不支持参数 {0}", key),400);
    for(const d of definitions){const v=profile.parameters[d.key];if(v===undefined){if(options.applyParameterDefaults!==false&&d.default!==undefined)profile.parameters[d.key]=d.default;continue;}if(v===null&&d.nullable)continue;
      if(typeof v!==d.type||typeof v==='number'&&(d.integer&&!Number.isInteger(v)||d.min!==undefined&&v<d.min||d.max!==undefined&&v>d.max)||typeof v==='string'&&d.options&&!d.options.includes(v))throw failure(moteText("参数 {0} 的值不合法", d.label),400);
    }
    if(plugin.dialogue){const speakers=fileProcessingSchema.parse({speakerCount:profile.parameters.speakerCount??null,speakerMin:profile.parameters.speakerMin??null,speakerMax:profile.parameters.speakerMax??null});if(speakers.speakerMin!==null&&profile.diarizationProcessor!=='audio.diarize-wespeaker')throw failure('Speaker range requires WeSpeaker',400);}
  }
  for(const rule of policy.rules){const profile=policy.profiles.find(p=>p.id===rule.profileId)!;if(profile.processorId==='archive')continue;
    const plugin=registry.list().find(p=>p.id===profile.processorId);if(!plugin)continue;
    if(!acceptsType(plugin.mediaTypes,rule.type))throw failure(moteText("方案「{0}」不支持类型 {1}", profile.name, rule.type),400);
  }
}

export function acceptsType(types:string[],pattern:string){return types.some(t=>matchesFileType(t.endsWith('/')?t+'*':t,pattern));}
