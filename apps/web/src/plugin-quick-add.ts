import {z} from 'zod';
import type {PluginReleasePreview} from '@mote/shared';

export const quickAddStorageKey='mote.plugin-quick-add';
export const quickRecipes=[{id:'mem0',name:'Mem0',repository:'mem0ai/mem0',tag:'ts-v3.3.1',package:'mote.mem0'},{id:'hindsight',name:'Hindsight',repository:'vectorize-io/hindsight',tag:'v0.10.2',package:'mote.hindsight'}] as const;
export type QuickRecipe=typeof quickRecipes[number];
export type QuickIntent={phase:'install'|'configure'|'check';path:string;method:'POST';body:string};
export type QuickAdd={version:1;scope:string;recipe:QuickRecipe['id'];preview:PluginReleasePreview;stage:'preview'|'installing'|'configure'|'configured'|'checking'|'verified';packageId?:string;instanceId?:string;pending?:QuickIntent;conflict?:boolean;viewRevision?:number;instanceSnapshot?:{revision:number;configuration:Record<string,string|number|boolean>}};
const id=z.string().uuid(),text=z.string().min(1).max(2000),strings=z.array(z.string());
const previewSchema=z.object({id,name:text,version:text,source:z.object({repository:text,tag:text,commit:z.string().regex(/^[a-f0-9]{40}$/),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),runtime:z.enum(['worker','service']),restartRequired:z.boolean(),capabilities:z.array(z.object({id:text,state:z.enum(['verified','unsupported','unknown']),reason:z.string().optional()}).strict()),dependencies:strings,access:strings,issues:strings,installable:z.boolean()}).strict();
const intentSchema=z.object({phase:z.enum(['install','configure','check']),path:text,method:z.literal('POST'),body:z.string().max(32000)}).strict();
const stateSchema=z.object({version:z.literal(1),scope:id,recipe:z.enum(['mem0','hindsight']),preview:previewSchema,stage:z.enum(['preview','installing','configure','configured','checking','verified']),packageId:text.optional(),instanceId:id.optional(),pending:intentSchema.optional(),conflict:z.boolean().optional(),viewRevision:z.number().int().positive().optional(),instanceSnapshot:z.object({revision:z.number().int().positive(),configuration:z.record(z.string(),z.union([z.string(),z.number(),z.boolean()]))}).strict().optional()}).strict();
const commandSchema=z.object({expectedRevision:z.number().int().positive(),operationId:id}).strict();
const endpoint=z.string().url().max(2000).refine(raw=>{const url=new URL(raw);return !url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));});
/** Only existing fixed-recipe fields and opaque credential references enter the
 * browser checkpoint. Tokens, arbitrary manifests and arbitrary commands do not. */
export function quickConfiguration(recipe:QuickRecipe['id'],raw:unknown):Record<string,string|number|boolean>{
 const configuration=typeof raw==='object'&&raw!==null?{...raw as Record<string,unknown>}:raw;
 if(recipe==='mem0'&&typeof configuration==='object'&&configuration!==null&&(configuration as Record<string,unknown>).embeddingSecretReference==='')delete (configuration as Record<string,unknown>).embeddingSecretReference;
 return (recipe==='mem0'?z.object({embeddingBaseUrl:endpoint,embeddingModel:text,embeddingDimension:z.number().int().positive(),embeddingSecretReference:z.string().regex(/^model:[^\s]+$/).optional()}):z.object({modelProfileId:text})).strict().parse(configuration);
}
export function quickPackage(value:Pick<QuickAdd,'recipe'|'preview'>){return quickRecipes.find(recipe=>recipe.id===value.recipe)!.package+'@'+value.preview.source.digest;}
function valid(value:unknown):QuickAdd{
 const parsed=stateSchema.parse(value),recipe=quickRecipes.find(recipe=>recipe.id===parsed.recipe)!;
 if(parsed.preview.source.repository!==recipe.repository||parsed.preview.source.tag!==recipe.tag||parsed.packageId&&parsed.packageId!==quickPackage(parsed))throw Error('Invalid fixed recipe identity');
 if(parsed.instanceSnapshot)quickConfiguration(parsed.recipe,parsed.instanceSnapshot.configuration);
 if(['configured','checking','verified'].includes(parsed.stage)&&!parsed.instanceSnapshot)throw Error('Missing configuration identity');
 if(parsed.pending){const intent=parsed.pending,body=JSON.parse(intent.body),command=commandSchema.parse({expectedRevision:body.expectedRevision,operationId:body.operationId});
  if(intent.phase==='install'){
   z.object({...commandSchema.shape,previewId:id}).strict().parse(body);
   if(intent.path!=='/api/plugins/install'||body.previewId!==parsed.preview.id)throw Error('Invalid install identity');
  }else if(intent.phase==='configure'){
   z.object({...commandSchema.shape,packageId:text,name:text,scope:z.literal('default'),configuration:z.unknown()}).strict().parse(body);
   quickConfiguration(parsed.recipe,body.configuration);
   if(intent.path!=='/api/plugin-instances'||body.packageId!==quickPackage(parsed)||parsed.instanceId!==command.operationId)throw Error('Invalid configuration identity');
  }else{
   commandSchema.parse(body);
   if(!parsed.instanceId||intent.path!=='/api/plugin-instances/'+parsed.instanceId+'/check')throw Error('Invalid check identity');
  }
 }
 return parsed as QuickAdd;
}
export function readQuickAdd(scope:string|undefined,storage:Pick<Storage,'getItem'|'removeItem'>=globalThis.sessionStorage):QuickAdd|undefined{
 try{const raw=storage.getItem(quickAddStorageKey);if(!raw)return;const value=valid(JSON.parse(raw));if(scope&&value.scope===scope)return value;storage.removeItem(quickAddStorageKey);}catch{try{storage.removeItem(quickAddStorageKey);}catch{/* blocked storage */}}
}
export function saveQuickAdd(value:QuickAdd,storage:Pick<Storage,'setItem'>=globalThis.sessionStorage):boolean{
 try{const text=JSON.stringify(valid(value));storage.setItem(quickAddStorageKey,text);return true;}catch{return false;}
}
export function clearQuickAdd(storage:Pick<Storage,'removeItem'>=globalThis.sessionStorage){try{storage.removeItem(quickAddStorageKey);}catch{/* no browser checkpoint */}}
