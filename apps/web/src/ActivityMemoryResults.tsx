import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {memoryStatus,type Memory} from './plugins/memory/Memories';

type ResultPage={ids:string[];total:number;nextCursor:string|null};
type ResultRow={id:string;memory?:Memory;error?:unknown};
type Snapshot={api:Api;workId:string;cursor:string|undefined;revision:number;page?:ResultPage;rows:ResultRow[];error?:unknown;loading:boolean};

/** The activity receipt identifies results, but is not authorization to read
 * their content. Every visible row and every open receives a fresh owner read. */
export function ActivityMemoryResults({api,workId,cursors,onCursors,onOpen,revision,onSettled,live,version,active=true}:{
 api:Api;workId:string;cursors:(string|undefined)[];onCursors:(value:(string|undefined)[])=>void;onOpen:(id:string)=>void;revision:number;onSettled:()=>void;live:boolean;version:string;active?:boolean;
}){
 const cursor=cursors.at(-1),[retry,setRetry]=useState(0),[snapshot,setSnapshot]=useState<Snapshot>(),[opening,setOpening]=useState<string>();
 const sequence=useRef(0),openingRead=useRef<AbortController|undefined>(undefined),errorFocus=useRef<HTMLElement|undefined>(undefined),retryButton=useRef<HTMLButtonElement>(null),section=useRef<HTMLElement>(null),rowHeights=useRef(new Map<string,number>()),identity=useRef({api,workId,cursor,revision,version});identity.current={api,workId,cursor,revision,version};
 const path='/api/work-activity/'+encodeURIComponent(workId)+'/memory-results?'+new URLSearchParams({limit:'20',...(cursor?{cursor}:{})});
 const visible=snapshot?.api===api&&snapshot.workId===workId&&snapshot.cursor===cursor&&snapshot.revision===revision?snapshot:undefined;
 useEffect(()=>{
  if(!active)return;
  const serial=++sequence.current,controller=new AbortController();openingRead.current?.abort();setOpening(undefined);
  const current=()=>!controller.signal.aborted&&serial===sequence.current;
  rowHeights.current.clear();for(const row of section.current?.querySelectorAll<HTMLButtonElement>('[data-activity-result-id]')??[]){const id=row.dataset.activityResultId;if(id)rowHeights.current.set(id,row.getBoundingClientRect().height);}
  setSnapshot(value=>value?.api===api&&value.workId===workId&&value.cursor===cursor&&value.revision===revision&&value.page?{...value,error:undefined,rows:value.rows.map(row=>({id:row.id})),loading:true}:{api,workId,cursor,revision,rows:[],loading:true});
  void (async()=>{try{
   const page=await api.request<ResultPage>(path,{signal:controller.signal});
   if(!Array.isArray(page.ids)||new Set(page.ids).size!==page.ids.length||!page.ids.every(id=>typeof id==='string')||!Number.isSafeInteger(page.total)||page.total<0||!(page.nextCursor===null||typeof page.nextCursor==='string'))throw Error(moteText('中央响应格式无效，请刷新后重试。'));
   const rows=await Promise.all(page.ids.map(async id=>{try{const memory=await api.request<Memory>('/api/memories/'+encodeURIComponent(id),{signal:controller.signal});if(memory.id!==id)throw Error('Memory identity mismatch');return {id,memory};}catch(error){return {id,error};}}));
   const verified=await api.request<ResultPage>(path,{signal:controller.signal});
   if(JSON.stringify(verified)!==JSON.stringify(page))throw Error(moteText('操作状态已变化，请重新读取后再确认。'));
   if(current()){const focused=document.activeElement;if(focused instanceof HTMLElement&&focused.dataset.activityResultId&&!page.ids.includes(focused.dataset.activityResultId))errorFocus.current=focused;setSnapshot({api,workId,cursor,revision,page,rows,loading:false});}
  }catch(error){if(current()){const focused=document.activeElement;if(focused instanceof HTMLElement&&focused.hasAttribute('data-activity-result-id'))errorFocus.current=focused;setSnapshot({api,workId,cursor,revision,rows:[],error,loading:false});}}})();
  return()=>{controller.abort();openingRead.current?.abort();++sequence.current;};
 },[api,workId,cursor,revision,version,retry,active]);
 useEffect(()=>{if(active&&visible&&!visible.loading)onSettled();},[visible,active]);
 useLayoutEffect(()=>{const previous=errorFocus.current;if(!previous||!visible||visible.loading)return;errorFocus.current=undefined;if(!previous.isConnected&&(document.activeElement===document.body||!document.activeElement))(retryButton.current??section.current?.querySelector<HTMLElement>('h2')??document.querySelector<HTMLElement>('.activity-detail h1'))?.focus({preventScroll:true});},[visible]);
 useEffect(()=>{
  if(!live||!active||!visible||visible.loading||opening)return;
  const refresh=()=>{if(!document.hidden&&!openingRead.current)setRetry(value=>value+1);};
  const timer=setTimeout(refresh,3000);
  document.addEventListener('visibilitychange',refresh);
  return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',refresh);};
 },[visible,active,opening,live]);
 const open=async(id:string)=>{
  openingRead.current?.abort();const controller=new AbortController();openingRead.current=controller;const serial=sequence.current,origin={api,workId,cursor,revision,version};setOpening(id);
  const current=()=>!controller.signal.aborted&&serial===sequence.current&&identity.current.api===origin.api&&identity.current.workId===origin.workId&&identity.current.cursor===origin.cursor&&identity.current.revision===origin.revision&&identity.current.version===origin.version;
  try{
   const page=await api.request<ResultPage>(path,{signal:controller.signal});if(!Array.isArray(page.ids)||!page.ids.includes(id))throw Error(moteText('请求的操作或资源已失效，请重新读取后再确认。'));
   const memory=await api.request<Memory>('/api/memories/'+encodeURIComponent(id),{signal:controller.signal});if(memory.id!==id)throw Error('Memory identity mismatch');
   const verified=await api.request<ResultPage>(path,{signal:controller.signal});if(!Array.isArray(verified.ids)||!verified.ids.includes(id))throw Error(moteText('请求的操作或资源已失效，请重新读取后再确认。'));
   if(current())onOpen(id);
  }catch(error){if(current())setSnapshot(value=>value&&value.api===api&&value.workId===workId&&value.cursor===cursor&&value.revision===revision?{...value,rows:value.rows.map(row=>row.id===id?{id,error}:row)}:value);}
  finally{if(openingRead.current===controller)openingRead.current=undefined;if(current())setOpening(undefined);}
 };
 if(visible?.page?.total===0&&cursors.length===1)return null;
 return <section ref={section} className="activity-results" aria-label={moteText('已保存成果')}>
  <div className="activity-section-head"><h2 tabIndex={-1}>{moteText('已保存成果')}</h2>{visible?.page&&<span>{moteText('{0} 项',visible.page.total)}</span>}</div>
  {(!visible||visible.loading&&!visible.page)&&<p role="status">{moteText('正在读取…')}</p>}
  {visible?.error!==undefined&&<p role="alert" className="notice error">{errorMessage(visible.error)} <button ref={retryButton} className="text-button" onClick={()=>setRetry(value=>value+1)}>{moteText('重试')}</button></p>}
  {visible?.page&&visible.rows.map(row=><div key={row.id} role={row.error!==undefined?'status':undefined}><button data-activity-result-id={row.id} data-activity-memory-id={row.memory?row.id:undefined} className="activity-result-row" style={visible.loading?{minHeight:rowHeights.current.get(row.id)}:undefined} aria-disabled={!row.memory||Boolean(opening)} onClick={()=>{if(row.memory&&!opening)void open(row.id);}}><span className="activity-result-symbol" aria-hidden="true">◇</span><span className="result-copy"><strong>{row.memory?row.memory.title:moteText(row.error!==undefined?'暂不可用':'正在读取…')}</strong>{row.memory?<small>{memoryStatus(row.memory,Date.now())}</small>:row.error instanceof Error?<small>{errorMessage(row.error)}</small>:<small aria-hidden="true">&nbsp;</small>}</span>{row.memory&&<ChevronRight size={15}/>}</button>{row.error!==undefined&&<button className="text-button" disabled={Boolean(opening)} onClick={()=>setRetry(value=>value+1)}>{moteText('重试')}</button>}</div>)}
  {visible?.page&&!visible.rows.length&&<p>{moteText('没有符合条件的内容')}</p>}
  {visible?.page&&(cursors.length>1||visible.page.nextCursor)&&<nav className="list-pagination" aria-label={moteText('已保存成果')}><span role="status">{moteText('第 {0} 页 · {1} 条',cursors.length,visible.rows.length)}</span><div><button className="button" disabled={cursors.length===1||Boolean(opening)} onClick={()=>onCursors(cursors.slice(0,-1))}>{moteText('上一页')}</button><button className="button" disabled={!visible.page.nextCursor||Boolean(opening)} onClick={()=>visible.page?.nextCursor&&onCursors([...cursors,visible.page.nextCursor])}>{moteText('下一页')}</button></div></nav>}
 </section>;
}
