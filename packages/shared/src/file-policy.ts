import {z} from 'zod';

const id=z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/);
export const fileTypePattern=z.string().regex(/^(?:\*\/\*|[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*))$/);
export const processorParameterSchema=z.object({
  key:z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),label:z.string().min(1).max(100),
  type:z.enum(['string','number','boolean']),nullable:z.boolean().optional(),
  default:z.union([z.string(),z.number().finite(),z.boolean(),z.null()]).optional(),
  min:z.number().finite().optional(),max:z.number().finite().optional(),integer:z.boolean().optional(),
  options:z.array(z.string().max(200)).max(100).optional(),description:z.string().max(500).optional(),
}).strict();
export type ProcessorParameter=z.infer<typeof processorParameterSchema>;
export const processingServiceSchema=z.object({
  id,name:z.string().trim().min(1).max(100),kind:z.enum(['asr','image','file','model']),
  execution:z.enum(['local','remote']),endpoint:z.string().max(2000),model:z.string().max(200).default(''),
  apiKey:z.string().max(4096).optional(),
}).strict().superRefine((s,c)=>{
  try{const u=new URL(s.endpoint),local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
    if(u.username||u.password||u.hash||u.search||!['http:','https:'].includes(u.protocol)||(s.execution==='local'?!local:u.protocol!=='https:'))throw Error();
  }catch{c.addIssue({code:'custom',message:'本地服务必须使用回环地址，远程服务必须使用 HTTPS，地址不可包含凭据或查询参数'});}
  if(s.kind==='model'&&!s.model.trim())c.addIssue({code:'custom',message:'语言模型服务需要填写模型名称'});
});
export const processingProfileSchema=z.object({
  id,name:z.string().trim().min(1).max(100),processorId:id,serviceId:id.optional(),
  parameters:z.record(z.string().max(64),z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()])).default({}),
  diarizationProcessor:id.default('audio.diarize'),modelServiceId:id.optional(),
  summarize:z.boolean().default(false),
}).strict();
export const filePolicySchema=z.object({
  version:z.literal(1),services:z.array(processingServiceSchema).max(100),profiles:z.array(processingProfileSchema).min(1).max(100),
  rules:z.array(z.object({sourceId:z.string().min(1).max(128).optional(),type:fileTypePattern,profileId:id}).strict()).min(1).max(500),
}).strict().superRefine((p,c)=>{
  for(const rows of [p.services,p.profiles])if(new Set(rows.map(r=>r.id)).size!==rows.length)c.addIssue({code:'custom',message:'服务和方案 ID 必须各自唯一'});
  if(new Set(p.rules.map(r=>`${r.sourceId??''}:${r.type}`)).size!==p.rules.length)c.addIssue({code:'custom',message:'同一来源和类型只能配置一条规则'});
  if(!p.rules.some(r=>!r.sourceId&&r.type==='*/*'))c.addIssue({code:'custom',message:'需要配置其他类型的默认规则'});
  for(const r of p.rules)if(!p.profiles.some(v=>v.id===r.profileId))c.addIssue({code:'custom',message:'规则引用了不存在的方案'});
  for(const v of p.profiles)for(const ref of [v.serviceId,v.modelServiceId].filter(Boolean))if(!p.services.some(s=>s.id===ref))c.addIssue({code:'custom',message:'方案引用了不存在的服务'});
});
export type FilePolicy=z.infer<typeof filePolicySchema>;
export type ProcessingProfile=z.infer<typeof processingProfileSchema>;
export type ProcessingService=z.infer<typeof processingServiceSchema>;
export type PolicyRule=FilePolicy['rules'][number];
export function matchesFileType(pattern:string,mime:string){return pattern==='*/*'||pattern===mime||pattern.endsWith('/*')&&mime.startsWith(pattern.slice(0,-1));}
/** Exact type wins within a source; source rules precede global rules. No content is inspected. */
export function resolveFileRule(policy:FilePolicy,sourceId:string,mime:string){
  const types=[mime,mime.split('/')[0]+'/*','*/*'];
  for(const source of [sourceId,undefined])for(const type of types){const rule=policy.rules.find(r=>r.sourceId===source&&r.type===type);if(rule)return rule;}
  throw new Error('Missing fallback file rule');
}
