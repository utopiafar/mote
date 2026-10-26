import {getLocale,moteText} from '@mote/shared/i18n';
import type {Config} from './contracts';
import {validateServerUrl} from './config';
import {requireConnectionToken} from './login-session';
import {readResponseText} from './response-body';
export type TopicDirectory={items:{id:string;label:string;nodes:{id:string;label:string;parentId?:string}[]}[];classification?:{state:string}};
export type TopicMemory={id:string;title:string;statement?:string;status:string;uncertainty?:string;evidenceIds?:string[]};
export type TopicPage={items:TopicMemory[];nextCursor?:string|null};
export type TopicQuery={treeId?:string;nodeId?:string;cursor?:string};
const key=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9.-]{0,99}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
async function read(config:Config,path:string){
 const response=await fetch(validateServerUrl(config.serverUrl)+path,{headers:{Authorization:`Bearer ${requireConnectionToken(config)}`,'Accept-Language':getLocale()},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok){await response.body?.cancel();throw Error(response.status===401||response.status===403?moteText('令牌无效或已失效，请检查后重新登录。'):moteText('操作失败'));}
 return JSON.parse(await readResponseText(response,4*1024*1024));
}
export async function centralMemoryTopics(config:Config):Promise<TopicDirectory>{
 const result=await read(config,'/api/context-trees');
 if(!Array.isArray(result.items)||result.items.length>100)throw Error('Invalid topic directory');
 const trees=new Set<string>();
 for(const tree of result.items){
  if(!key(tree.id)||trees.has(tree.id)||typeof tree.label!=='string'||tree.label.length>100||!Array.isArray(tree.nodes)||tree.nodes.length>500)throw Error('Invalid topic tree');trees.add(tree.id);
  const nodes=new Map<string,{parentId?:string}>();
  for(const node of tree.nodes){if(!key(node.id)||nodes.has(node.id)||typeof node.label!=='string'||node.label.length>100||node.parentId!==undefined&&!key(node.parentId))throw Error('Invalid topic node');nodes.set(node.id,node);}
  for(const [id,node] of nodes){const seen=new Set([id]);let parent=node.parentId;while(parent){if(seen.has(parent)||!nodes.has(parent))throw Error('Invalid topic ancestry');seen.add(parent);parent=nodes.get(parent)!.parentId;}}
 }
 return result;
}
function memory(row:TopicMemory){if(!row||!uuid(row.id)||typeof row.title!=='string'||typeof row.status!=='string'||row.statement!==undefined&&typeof row.statement!=='string'||row.evidenceIds!==undefined&&(!Array.isArray(row.evidenceIds)||row.evidenceIds.some(id=>!uuid(id))))throw Error('Invalid topic memory');return row;}
export async function centralMemoryTopicPage(config:Config,input:TopicQuery={}):Promise<TopicPage>{
 if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['treeId','nodeId','cursor'].includes(k))||(input.treeId===undefined)!==(input.nodeId===undefined)||input.treeId!==undefined&&(!key(input.treeId)||!key(input.nodeId))||input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor.length||input.cursor.length>8192))throw Error('Invalid topic query');
 const path=input.treeId?`/api/context-trees/${encodeURIComponent(input.treeId)}/nodes/${encodeURIComponent(input.nodeId!)}`:'/api/memories';
 const result=await read(config,path+'?'+new URLSearchParams({limit:'30',...(input.cursor?{cursor:input.cursor}:{})}));
 if(!Array.isArray(result.items)||result.items.length>30||result.nextCursor!=null&&(typeof result.nextCursor!=='string'||result.nextCursor.length>8192))throw Error('Invalid topic page');result.items.forEach(memory);return result;
}
export async function centralMemoryTopicDetail(config:Config,id:string):Promise<TopicMemory>{if(!uuid(id))throw Error('Invalid memory reference');return memory(await read(config,'/api/memories/'+id));}
export type TopicEvidence={id:string;text:string;metadata:string};
/** Member-bound read; the caller checks the current connection after each await. */
export async function centralMemoryTopicEvidence(config:Config,memoryId:string,evidenceId:string,assertCurrent:()=>void):Promise<TopicEvidence>{
 if(!uuid(memoryId)||!uuid(evidenceId))throw Error('Invalid memory evidence reference');
 const current=await centralMemoryTopicDetail(config,memoryId);assertCurrent();
 if(!current.evidenceIds?.includes(evidenceId))throw Error('Evidence is not a member of this Memory');
 const capture=await read(config,'/api/captures/'+evidenceId);assertCurrent();
 if(capture.id!==evidenceId)throw Error('Invalid evidence response');
 return {id:evidenceId,text:typeof capture.ocrText==='string'?capture.ocrText:'',metadata:JSON.stringify({capturedAt:capture.capturedAt,deviceName:capture.deviceName,appName:capture.appName,source:capture.source,provenance:capture.provenance,metadata:capture.metadata},null,2)};
}
