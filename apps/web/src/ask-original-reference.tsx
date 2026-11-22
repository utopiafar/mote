import {pageHash} from '@mote/shared';
import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import type {Material} from './Materials';
type Origin={kind:'memory'|'capture'|'material'|'insight';id:string;materialOnly?:true};
type MaterialSelection={kind:'selection';sourceIds:string[]};
const referenceReturns=new WeakMap<Api,Map<string,string>>();
export function rememberOriginalReturn(api:Api,kind:Origin['kind'],id:string){let values=referenceReturns.get(api);if(!values){values=new Map();referenceReturns.set(api,values);}values.set(kind+':'+id,window.location.hash);}
export function originalReferenceRoute(kind:Origin['kind'],id:string){return pageHash('chat',{[kind==='memory'?'fromMemory':kind==='material'?'fromMaterial':kind==='insight'?'fromInsight':'fromCapture']:id});}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function readOrigin():Origin|null{const query=new URLSearchParams(window.location.hash.split('?')[1]);for(const [key,kind] of [['fromMemory','memory'],['fromMaterial','material'],['fromCapture','capture'],['fromInsight','insight']] as const){const id=query.get(key);if(id)return {kind,id,...(kind==='material'&&query.get('materialOnly')==='1'?{materialOnly:true as const}:{})};}return null;}
const unavailable=()=>moteText('参考原件不可用。清除参考后继续。');
/** Re-read the selected entity and every exact original. A displayed evidence
 * subset never becomes the scope, and a newer Material never replaces a pin. */
export async function verifiedOriginals(api:Api,origin:Origin,signal:AbortSignal):Promise<{ids:string[];title:string;materialRef?:string;scope?:MaterialSelection}>{
 let ids:string[],title:string;
 if(origin.kind==='material'){
  const match=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/.exec(origin.id);if(!match)throw Error(unavailable());
  const material=await api.request<Material>('/api/materials/'+match[1],{signal});
  if(material.ref!==origin.id||material.revision!==match[2])throw Error(unavailable());
  const page=await api.request<{material:Material}>(`/api/materials/${match[1]}/read?revision=${match[2]}&offset=0&length=2`,{signal});
  if(page.material.ref!==origin.id)throw Error(unavailable());
  if(origin.materialOnly&&(typeof material.origin?.sourceId!=='string'||!material.origin.sourceId))throw Error(unavailable());
  return {ids:[],title:material.title,materialRef:origin.id,...(origin.materialOnly?{scope:{kind:'selection' as const,sourceIds:[material.origin.sourceId]}}:{})};
 }else{
  if(!uuid.test(origin.id))throw Error(unavailable());
  const report=origin.kind==='insight'?await api.request<{runId:string;artifact?:{title:string};citations:{id:string}[]}>('/api/insights/'+origin.id,{signal}):undefined;
  if(origin.kind==='insight'&&(!report||report.runId!==origin.id||!Array.isArray(report.citations)))throw Error(unavailable());
  const memory=origin.kind==='memory'?await api.request<{title:string;evidenceIds?:string[];evidenceCount?:number;evidence?:{id:string}[]}>('/api/memories/'+origin.id,{signal}):undefined;
  // Full saved IDs are authoritative. Union retains any explicit evidence the
  // detail adds, while a larger count fails rather than silently narrowing.
  ids=report?[...new Set(report.citations.map(item=>item.id))]:memory?[...new Set([...(memory.evidenceIds??[]),...(memory.evidence??[]).map(item=>item.id)])]:[origin.id];title=report?.artifact?.title??(report?moteText('发现'):memory?.title??moteText('原始记录'));
  if(memory?.evidenceCount!==undefined&&memory.evidenceCount>ids.length)throw Error(unavailable());
 }
 if(ids.length>30)throw Error(moteText('原始依据超过本次问答的 30 条上限；正文仍可阅读。'));
 if(!ids.length||ids.some(id=>!uuid.test(id)))throw Error(unavailable());
 await Promise.all(ids.map(id=>api.request('/api/capture-browser/'+id,{signal})));
 return {ids:[...new Set(ids)],title};
}
export function useOriginalReference(api:Api){
 const [origin,setOrigin]=useState(readOrigin),[read,setRead]=useState<{owner:Api;key:string;ids:string[];title:string;materialRef?:string;scope?:MaterialSelection;error?:string}>();
 const returnKey=origin?origin.kind+':'+origin.id:'',key=returnKey+(origin?.materialOnly?':selection':'');
 useEffect(()=>{const sync=()=>setOrigin(readOrigin());window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
 useEffect(()=>{if(!origin){setRead(undefined);return;}const controller=new AbortController();setRead(undefined);
  void verifiedOriginals(api,origin,controller.signal).then(value=>{if(!controller.signal.aborted)setRead({owner:api,key,...value});}).catch(error=>{if(!controller.signal.aborted)setRead({owner:api,key,ids:[],title:'',error:errorMessage(error)});});return()=>controller.abort();
 },[api,key]);
 const current=read?.owner===api&&read.key===key?read:undefined;
 function clear(){setOrigin(null);setRead(undefined);const [route,text]=window.location.hash.split('?'),query=new URLSearchParams(text);for(const field of ['fromMemory','fromMaterial','fromCapture','fromInsight','materialOnly'])query.delete(field);window.history.replaceState(null,'',route+(query.size?'?'+query:''));window.dispatchEvent(new window.Event('mote:workspace-state'));}
 async function verify(signal:AbortSignal){if(!origin)return;const fresh=await verifiedOriginals(api,origin,signal);if(!current||fresh.materialRef!==current.materialRef||JSON.stringify(fresh.scope)!==JSON.stringify(current.scope)||JSON.stringify([...fresh.ids].sort())!==JSON.stringify([...current.ids].sort()))throw Error(unavailable());}
 return {key,origin,returnRoute:referenceReturns.get(api)?.get(returnKey),ids:current?.ids??[],materialRef:current?.materialRef,scope:current?.scope,title:current?.title??'',error:current?.error,loading:Boolean(origin&&!current),ready:!origin||Boolean(current&&!current.error&&(current.materialRef||current.ids.length)),clear,verify};
}
