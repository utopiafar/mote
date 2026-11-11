import {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {sourceContextSnapshotSchema,type SourceContextSnapshot} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from '../../api';
import {useUnsavedChanges} from '../../unsaved';
import { Loading } from '../../Loading';

type DraftState={description:string;baseline?:SourceContextSnapshot;dirty:boolean;loading:boolean;saving:boolean;error:string;conflict:boolean;saved:boolean};
type Session={api:Api;sourceId?:string;scope:AbortController;read?:AbortController;write?:AbortController;pendingSave?:Promise<SourceContextSnapshot|undefined>;state:DraftState};
const initialState=():DraftState=>({description:'',dirty:false,loading:false,saving:false,error:'',conflict:false,saved:false});
const aborted=()=>new DOMException('Aborted','AbortError');

/** Owner prose uses its own versioned control plane. Reading other source
 * settings must not advance the expected version beneath an edited draft. */
export function useSourceContextDraft(api:Api,sourceId?:string){
 const session=useMemo<Session>(()=>({api,sourceId,scope:new AbortController(),state:initialState()}),[api,sourceId]);
 const current=useRef(session);current.current=session;
 const [,render]=useState(0);
 const publish=useCallback((patch:Partial<DraftState>)=>{if(current.current!==session)return;session.state={...session.state,...patch};render(value=>value+1);},[session]);
 const load=useCallback(async(discard:boolean)=>{
  if(!session.sourceId)return;
  if(current.current!==session||session.scope.signal.aborted)throw aborted();
  if(session.pendingSave)return;
  session.read?.abort();const request=new AbortController();session.read=request;
  const signal=AbortSignal.any([session.scope.signal,request.signal]);
  publish({loading:true,...(!session.state.conflict?{error:''}:{})});
  try{
   const snapshot=sourceContextSnapshotSchema.parse(await session.api.request<SourceContextSnapshot>('/api/sources/'+encodeURIComponent(session.sourceId)+'/context',{signal}));
   signal.throwIfAborted();if(current.current!==session)throw aborted();
   if(snapshot.sourceId!==session.sourceId)throw new Error('Source context response does not match the requested source');
   if(discard||!session.state.dirty){publish({baseline:snapshot,description:snapshot.description,dirty:false,error:'',conflict:false,saved:false});}
   else if(!session.state.baseline){publish({baseline:snapshot,dirty:session.state.description!==snapshot.description});}
   return snapshot;
  }catch(error){if(!signal.aborted&&current.current===session)publish({error:errorMessage(error)});throw error;}
  finally{if(session.read===request){session.read=undefined;if(current.current===session&&!session.scope.signal.aborted)publish({loading:false});}}
 },[session,publish]);
 useEffect(()=>{
  const scope=new AbortController();session.scope=scope;
  void load(false).catch(()=>{});
  return()=>scope.abort();
 },[session,load]);
 const setDescription=useCallback((description:string)=>{
  if(current.current!==session)return;
  publish({description,dirty:description!==(session.state.baseline?.description??''),saved:false,...(!session.state.conflict?{error:''}:{})});
 },[session,publish]);
 const save=useCallback(async(ownerSignal?:AbortSignal):Promise<SourceContextSnapshot|undefined>=>{
  ownerSignal?.throwIfAborted();
  if(current.current!==session||session.scope.signal.aborted)throw aborted();
  if(!session.sourceId)return;
  if(session.pendingSave)return session.pendingSave;
  const {baseline,description,dirty}=session.state;
  if(!baseline)throw new Error(session.state.error||moteText('正在读取资料说明…'));
  if(!dirty)return baseline;
  if(description.length>12000){const error=new Error(moteText('资料说明最多 12000 字符'));publish({error:error.message});throw error;}
  session.read?.abort();session.read=undefined;
  const request=new AbortController();session.write=request;
  const signal=AbortSignal.any([session.scope.signal,request.signal,...(ownerSignal?[ownerSignal]:[])]);
  publish({saving:true,loading:false,error:'',saved:false});
  const pending=Promise.resolve().then(async()=>{
   try{
    signal.throwIfAborted();
    const snapshot=sourceContextSnapshotSchema.parse(await session.api.request<SourceContextSnapshot>('/api/sources/'+encodeURIComponent(session.sourceId!)+'/context',{method:'PATCH',signal,body:JSON.stringify({expectedVersion:baseline.version,description})}));
    signal.throwIfAborted();if(current.current!==session)throw aborted();
    if(snapshot.sourceId!==session.sourceId)throw new Error('Source context response does not match the requested source');
    // An edit made while this request was in flight remains a draft against its ACK.
    const edited=session.state.description;
    publish({baseline:snapshot,dirty:edited!==snapshot.description,error:'',conflict:false,saved:edited===snapshot.description});
    return snapshot;
   }catch(error){
    if(!signal.aborted&&current.current===session)publish({error:errorMessage(error),conflict:typeof error==='object'&&error!==null&&'status' in error&&error.status===409});
    throw error;
   }finally{
    if(session.write===request){session.write=undefined;session.pendingSave=undefined;if(current.current===session&&!session.scope.signal.aborted)publish({saving:false});}
   }
  });
  session.pendingSave=pending;return pending;
 },[session,publish]);
 const refresh=useCallback(()=>load(false),[load]),reload=useCallback(()=>load(true),[load]);
 const state=session.state;
 return {description:state.description,setDescription,dirty:state.dirty,ready:Boolean(state.baseline),busy:state.loading||state.saving,loading:state.loading,error:state.error,conflict:state.conflict,saved:state.saved,version:state.baseline?.version,save,refresh,reload};
}
export type SourceContextDraft=ReturnType<typeof useSourceContextDraft>;

/** Shared fields let recording settings acknowledge prose before enabling intake. */
export function SourceContextFields({draft,disabled=false}:{draft:SourceContextDraft;disabled?:boolean}){
 const help=useId();
 return <div className="source-context-fields">
  <label className="field-label">{moteText('资料说明（选填）')}<textarea value={draft.description} maxLength={12000} rows={4} disabled={disabled||draft.busy||!draft.ready} aria-describedby={help} placeholder={moteText('可说明格式、时间、作者，以及哪些内容属于你。')} onChange={event=>draft.setDescription(event.target.value)}/></label>
  <div id={help} className="field-note"><p>{moteText('用于理解这个来源的背景、作者和内容归属。')}</p><p>{moteText('来源声明应用于已有和新资料；单份资料的声明优先。')}</p><p>{moteText('修改说明适用于已有和未来资料；不会自动重新转写或重算历史记忆。')}</p></div>
  {draft.loading&&<Loading label={moteText('正在读取资料说明…')}/>}
  {draft.error&&<p className="notice error" role="alert">{draft.error}{draft.conflict&&<> {moteText('资料说明版本已变化；草稿已保留，请重新加载最新版本后再保存。')}</>}</p>}
  {(draft.error||draft.dirty)&&<button className="button subtle" type="button" disabled={disabled||draft.busy} onClick={()=>void draft.reload().catch(()=>{})}>{moteText(draft.dirty?'放弃修改并重新加载':'重新加载')}</button>}
  {draft.saved&&<p role="status">{moteText('资料说明已获中央确认，版本 {0}。',draft.version??0)}</p>}
 </div>;
}
export function SourceContextEditor({api,sourceId}:{api:Api;sourceId:string}){
 const draft=useSourceContextDraft(api,sourceId);
 useUnsavedChanges(draft.dirty);
 return <section className="source-item source-context-editor"><SourceContextFields draft={draft}/><button className="button primary" type="button" disabled={!draft.ready||!draft.dirty||draft.busy} onClick={()=>void draft.save().catch(()=>{})}>{moteText(draft.busy?'正在保存…':'保存说明')}</button></section>;
}
