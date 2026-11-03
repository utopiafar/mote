import {useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {ArrowLeft,ArrowRight,ChevronDown,ChevronRight,FileCheck2,Eye} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {formatEvidenceRef,parseEvidenceId,parseEvidenceRef,type WorkActivity,type WorkActivityPage} from '@mote/shared';
import {type Api,errorMessage,dateTime} from '../../api';
import {useResource} from '../../useResource';
import {operationFeed} from './operation-feed';
import {ListPagination,useCursorPages} from '../../ListPagination';
import {WorkProgress,WorkStateBadge,workStateLabels} from './WorkProgress';
import type {Page} from '../../navigation';
import {FeaturePanels} from '../../features/runtime';
import {WorkIssueNotice} from './WorkIssueNotice';
import {CodingReceiptPanel} from '../../CodingReceiptPanel';
import {Imports} from '../../Imports';
import {MemoryDetailPage} from '../memory/Memories';
import {ActivityMemoryResults} from '../../ActivityMemoryResults';
import {confirmNavigation} from '../../unsaved';

const activityKinds:Record<string,{label:string;symbol:string}>={import:{label:'资料导入',symbol:'⇣'},memory:{label:'记忆整理',symbol:'◈'},insight:{label:'回顾',symbol:'✧'},query:{label:'回答问题',symbol:'↗'}};
type Section='progress'|'evidence'|'branches'|'technical';
type DetailVisit={sections:Record<Section,boolean>;cursors:(number|undefined)[];memoryCursors:(string|undefined)[];scroll:number;memoryEntries:Map<string,{memoryId:string;cursors:(string|undefined)[];scroll:number}>};
const visits=new WeakMap<Api,Map<string,DetailVisit>>();
function detailVisit(api:Api,id:string){let owner=visits.get(api);if(!owner){owner=new Map();visits.set(api,owner);}let value=owner.get(id);if(!value){value={sections:{progress:true,evidence:false,branches:false,technical:false},cursors:[undefined],memoryCursors:[undefined],scroll:0,memoryEntries:new Map()};owner.set(id,value);}return value;}
const eventLabels={'work.started':'工作已开始','plan.updated':'工作计划已更新','branch.started':'工作分支已开始','branch.completed':'工作分支已完成','branch.replanned':'已调整工作分支','artifact.created':'已保存工作成果','work.needs_input':'工作需要补充','work.completed':'工作已完成','work.failed':'工作未能完成','work.cancelled':'工作已停止'};
function WorkDetail({api,id,onBack,onNavigate,onOpen}:{api:Api;id:string;onBack:()=>void;onNavigate:(page:Page)=>void;onOpen:(ref:string)=>void}){
 const ui=useMemo(()=>detailVisit(api,id),[api,id]),[,redraw]=useState(0);
 const [related,setRelated]=useState<{owner:Api;id:string;memoryId?:string}|undefined>(),[memoryRevision,setMemoryRevision]=useState(0),[historyError,setHistoryError]=useState<unknown>();
 const relatedOpen=related?.owner===api&&related.id===id;
 const memoryOpen=relatedOpen&&related?.memoryId;
 const memoryReturn=useRef<{owner:Api;workId:string;memoryId:string}|undefined>(undefined);
 const showingRelated=useRef(relatedOpen);showingRelated.current=relatedOpen;
 const relatedRef=useRef(related);relatedRef.current=related;
 const paging={cursor:ui.cursors.at(-1),page:ui.cursors.length,reset:()=>{ui.scroll=window.scrollY;ui.cursors=[undefined];redraw(value=>value+1);},previous:()=>{ui.scroll=window.scrollY;if(ui.cursors.length>1)ui.cursors=ui.cursors.slice(0,-1);redraw(value=>value+1);},next:(cursor:number)=>{ui.scroll=window.scrollY;ui.cursors=[...ui.cursors,cursor];redraw(value=>value+1);}};
 const {data:work,error,loading,refresh}=useResource<WorkActivity>(api,'/api/work-activity/'+encodeURIComponent(id)+'?'+new URLSearchParams({limit:'20',...paging.cursor?{cursor:String(paging.cursor)}:{}}),3000);
 const remember=()=>{ui.scroll=window.scrollY;};
 useEffect(()=>{
  const rememberCurrentScroll=()=>{
   const [route,search]=window.location.hash.split('?');
   if(!showingRelated.current&&route==='#/activity'&&new URLSearchParams(search??'').get('work')===id)ui.scroll=window.scrollY;
  };
  window.addEventListener('scroll',rememberCurrentScroll,{passive:true});
  return()=>{rememberCurrentScroll();window.removeEventListener('scroll',rememberCurrentScroll);};
 },[ui,id]);
 useEffect(()=>{
  let alive=true,read:AbortController|undefined;
  const changed=()=>{
   read?.abort();const token=window.history.state?.moteActivityMemory,entry=typeof token==='string'?ui.memoryEntries.get(token):undefined;
   if(!entry){if(relatedRef.current?.owner===api&&relatedRef.current.id===id&&relatedRef.current.memoryId){setRelated(undefined);setMemoryRevision(value=>value+1);refresh();}return;}
   if(relatedRef.current?.owner===api&&relatedRef.current.id===id&&relatedRef.current.memoryId===entry.memoryId)return;
   ui.memoryCursors=[...entry.cursors];ui.scroll=entry.scroll;redraw(value=>value+1);
   const controller=new AbortController();read=controller;const cursor=entry.cursors.at(-1),path='/api/work-activity/'+encodeURIComponent(id)+'/memory-results?'+new URLSearchParams({limit:'20',...(cursor?{cursor}:{})});
   const current=()=>alive&&!controller.signal.aborted&&window.history.state?.moteActivityMemory===token&&new URLSearchParams(window.location.hash.split('?')[1]??'').get('work')===id;
   void (async()=>{try{const page=await api.request<{ids:string[]}>(path,{signal:controller.signal});if(!page.ids.includes(entry.memoryId))throw Error(moteText('请求的操作或资源已失效，请重新读取后再确认。'));const memory=await api.request<{id:string}>('/api/memories/'+encodeURIComponent(entry.memoryId),{signal:controller.signal});if(memory.id!==entry.memoryId)throw Error(moteText('中央响应格式无效，请刷新后重试。'));const verified=await api.request<{ids:string[]}>(path,{signal:controller.signal});if(!verified.ids.includes(entry.memoryId))throw Error(moteText('请求的操作或资源已失效，请重新读取后再确认。'));if(current()){setHistoryError(undefined);showingRelated.current=true;memoryReturn.current={owner:api,workId:id,memoryId:entry.memoryId};setRelated({owner:api,id,memoryId:entry.memoryId});window.scrollTo?.(0,0);}}catch(error){if(current()){setRelated(undefined);setHistoryError(error);setMemoryRevision(value=>value+1);}}})();
  };
  window.addEventListener('popstate',changed);changed();return()=>{alive=false;read?.abort();window.removeEventListener('popstate',changed);};
 },[api,id,ui]);
 useLayoutEffect(()=>{if(work&&!relatedOpen){document.querySelector<HTMLHeadingElement>('.activity-detail h1')?.focus({preventScroll:true});window.scrollTo?.(0,ui.scroll);}},[ui,Boolean(work),relatedOpen]);
 const toggle=(key:Section,open:boolean)=>{if(ui.sections[key]!==open){ui.sections[key]=open;redraw(value=>value+1);}};
 const go=(page:Page)=>{remember();onNavigate(page);};
 const open=(ref:string)=>{if(!relatedOpen)remember();onOpen(parseEvidenceId(ref)?formatEvidenceRef('capture',ref):ref);};
 const restoreMemoryResult=()=>{const pending=memoryReturn.current;if(!pending||pending.owner!==api||pending.workId!==id||showingRelated.current)return;memoryReturn.current=undefined;const button=[...document.querySelectorAll<HTMLButtonElement>('[data-activity-memory-id]')].find(value=>value.dataset.activityMemoryId===pending.memoryId);(button??document.querySelector<HTMLHeadingElement>('.activity-detail h1'))?.focus({preventScroll:true});window.scrollTo?.(0,ui.scroll);};
 const inspector=()=>{const runId=work?.evidence.runId??work?.technical.runId;go('agentView');if(runId)window.location.hash='#/agent?runId='+encodeURIComponent(runId);};
 const importId=work?.kind==='import'&&id.startsWith('import:')?id.slice('import:'.length):undefined;
 const relatedAction=()=>{if(importId){remember();setRelated({owner:api,id});window.scrollTo?.(0,0);}else if(work)go(work.destination);};
 const relatedLabel=work?.kind==='import'?work.state==='needs_input'?'核对解析预览':['failed','stale'].includes(work.state)?'查看导入并重试':'查看导入':'打开相关资料与操作';
 const attention=work&&['needs_input','failed','stale'].includes(work.state);
 return <div className="activity-detail">
  <div hidden={relatedOpen} data-activity-main>
  <div className="activity-detail-toolbar"><button className="back-link" onClick={onBack}><ArrowLeft size={14}/>{moteText('返回活动')}</button><button className="text-button" disabled={loading} onClick={()=>{refresh();setMemoryRevision(value=>value+1);}}>{moteText('刷新')}</button></div>
  {historyError!==undefined&&<p role="alert" className="notice error">{errorMessage(historyError)} <button className="text-button" onClick={()=>{setHistoryError(undefined);setMemoryRevision(value=>value+1);}}>{moteText('重试')}</button></p>}
  {error!==undefined&&<p role="alert" className="notice error">{errorMessage(error)} <button className="text-button" onClick={refresh}>{moteText('重试')}</button></p>}{loading&&!work&&<p role="status">{moteText('正在读取…')}</p>}
  {work&&<>
   <header className="activity-detail-header"><div className="activity-detail-kind">{moteText(({import:'资料导入',memory:'记忆整理',insight:'回顾',query:'回答问题'} as Record<string,string>)[work.kind]??'后台活动')}</div><div className="activity-detail-title"><h1 tabIndex={-1}>{work.goal}</h1><WorkStateBadge state={work.state}/></div><p>{moteText('{0} 开始 · {1} 更新',dateTime(work.createdAt),dateTime(work.updatedAt))}</p></header>
   {attention?<section className="activity-current attention"><WorkIssueNotice api={api} work={work} hideUnknownCode/><button className="button" onClick={relatedAction}>{moteText(relatedLabel)}<ArrowRight size={14}/></button></section>:work.state!=='completed'&&<section className="activity-current"><div className="activity-current-title"><h2>{work.progress.mode==='semantic'&&work.progress.summary||moteText(workStateLabels[work.state])}</h2></div>{work.progress.mode==='semantic'&&<WorkProgress progress={work.progress}/>}<button className="button" onClick={relatedAction}>{moteText(relatedLabel)}<ArrowRight size={14}/></button></section>}
   {work.progress.mode==='determinate'&&<div className="activity-known-progress"><WorkProgress progress={work.progress}/></div>}
   {work.kind==='memory'?<ActivityMemoryResults api={api} workId={id} cursors={ui.memoryCursors} live={work.state==='running'||work.state==='waiting'} version={work.updatedAt} active={!relatedOpen} revision={memoryRevision} onSettled={restoreMemoryResult} onCursors={value=>{remember();ui.memoryCursors=value;redraw(current=>current+1);}} onOpen={memoryId=>{remember();const token=crypto.randomUUID();ui.memoryEntries.set(token,{memoryId,cursors:[...ui.memoryCursors],scroll:ui.scroll});window.history.pushState({...window.history.state,moteActivityMemory:token},'',window.location.href);memoryReturn.current={owner:api,workId:id,memoryId};setHistoryError(undefined);showingRelated.current=true;setRelated({owner:api,id,memoryId});window.scrollTo?.(0,0);}}/>:work.artifacts.length>0&&<section className="activity-results" aria-label={moteText('已保存成果')}><div className="activity-section-head"><h2>{moteText('已保存成果')}</h2><span>{moteText('{0} 项',work.artifacts.length)}</span></div>{work.artifacts.map(artifact=>{const copy=<><span className="activity-result-symbol"><FileCheck2 size={18}/></span><span className="result-copy"><strong>{artifact.title}</strong>{artifact.summary&&<small>{artifact.summary}</small>}</span><ChevronRight size={15}/></>;return artifact.href?<a key={artifact.id} className="activity-result-row" href={artifact.href} onClick={remember}>{copy}</a>:<button key={artifact.id} className="activity-result-row" onClick={()=>{if(artifact.ref&&parseEvidenceRef(artifact.ref))open(artifact.ref);else relatedAction();}}>{copy}</button>;})}</section>}
   <FeaturePanels api={api} onOpen={open} value={{kind:'mote.work.activity',schemaVersion:1,representation:'overview',ref:work.id,revision:work.updatedAt,title:work.goal,text:'',operationIds:work.technical.operationIds}}/>
   <details className="activity-section" data-activity-section="progress" open={ui.sections.progress} onToggle={event=>toggle('progress',event.currentTarget.open)}><summary>{moteText('进展')}<ChevronDown size={13}/></summary>{work.events.length?<ol className="activity-events">{work.events.map(event=><li key={event.id}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time><span className="activity-event-dot" aria-hidden="true"/><span>{event.summary??moteText(eventLabels[event.type])}</span></li>)}</ol>:<p className="activity-empty-detail">{moteText('目前还没有进展记录。')}</p>}</details>
   {(work.evidence.count>0||work.evidence.refs.length>0)&&<details className="activity-section" data-activity-section="evidence" open={ui.sections.evidence} onToggle={event=>toggle('evidence',event.currentTarget.open)}><summary>{moteText('原始依据')}<small>{moteText('{0} 份',work.evidence.count)}</small><ChevronDown size={13}/></summary>{work.evidence.refs.map((ref,index)=><button className="activity-proof" aria-label={moteText('来源资料 {0}',index+1)} key={ref} onClick={()=>open(ref)}><span className="proof-number">{index+1}</span><span><strong>{moteText('来源资料 {0}',index+1)}</strong></span><ChevronRight size={14}/></button>)}{work.evidence.count>work.evidence.refs.length&&<p className="fine-print">{moteText('这里只列出前 {0} 条资料；完整范围可在相关资料中查看。',work.evidence.refs.length)}</p>}<button className="text-button" onClick={inspector}><Eye size={14}/>{moteText(work.evidence.runId??work.technical.runId?'查看 Agent 实际输入':'查看 Agent 可访问范围')}</button></details>}
   {(work.branches.length>0||Boolean(work.branchCounts?.total)||Boolean(work.branchesNextCursor))&&<details className="activity-section" data-activity-section="branches" open={ui.sections.branches} onToggle={event=>toggle('branches',event.currentTarget.open)}><summary>{moteText('工作分支')}{work.branchCounts&&<small>{moteText('{0} 个',work.branchCounts.total)}</small>}<ChevronDown size={13}/></summary><div className="activity-branches">{work.branches.map(branch=><article className="activity-branch" key={branch.id}><div><strong>{branch.title}</strong>{branch.artifactIds.length>0&&<small>{moteText('{0} 项已保存成果',branch.artifactIds.length)}</small>}{branch.progress&&<WorkProgress progress={branch.progress}/>}</div><WorkStateBadge state={branch.state}/></article>)}</div><ListPagination label={moteText('工作分支分页')} paging={paging} nextCursor={work.branchesNextCursor} count={work.branches.length} loading={loading}/></details>}
   <details className="activity-section activity-technical" data-activity-section="technical" open={ui.sections.technical} onToggle={event=>toggle('technical',event.currentTarget.open)}><summary>{moteText('运行信息')}<ChevronDown size={13}/></summary><p>{moteText('技术执行记录、尝试次数与依赖用于排查问题。')}</p><dl><dt>{moteText('执行记录')}</dt><dd>{work.technical.operationIds.map(operationId=><div key={operationId}><code>{operationId}</code></div>)}</dd><dt>{moteText('执行状态')}</dt><dd><WorkStateBadge state={work.state}/></dd>{(work.technical.runId??work.evidence.runId)&&<><dt>{moteText('运行编号')}</dt><dd><code>{work.technical.runId??work.evidence.runId}</code></dd></>}</dl><div className="processing-actions"><button className="button" onClick={()=>go('processing')}>{moteText('技术执行记录')}</button><button className="text-button" onClick={inspector}>{moteText('Agent 读取轨迹')}</button><button className="text-button" onClick={relatedAction}>{moteText('打开相关资料与操作')}<ArrowRight size={14}/></button></div></details>
  </>}
  </div>
  {relatedOpen&&importId&&!memoryOpen&&<section className="activity-related-import"><button className="back-link" onClick={()=>{if(confirmNavigation()){setRelated(undefined);refresh();}}}><ArrowLeft size={14}/>{moteText('返回活动详情')}</button><Imports api={api} initialJobId={importId} onOpen={open} onMemories={()=>go('memories')} onSettings={()=>go('settings')} onChanged={refresh}/></section>}
  {memoryOpen&&<MemoryDetailPage api={api} id={memoryOpen} isolatedSelection onOpen={open} onBack={()=>{const token=window.history.state?.moteActivityMemory;if(typeof token==='string'&&ui.memoryEntries.has(token))window.history.back();else{setRelated(undefined);setMemoryRevision(value=>value+1);refresh();}}}/>}
 </div>;
}
export function Activity({ api, onNavigate, onOpen }: {
    api: Api;
    onNavigate: (page: Page) => void;
    onOpen: (ref: string) => void;
}) {
    const [state, setState] = useState<'active' | 'attention' | 'completed'>('active'), [selected, setSelected] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]).get('work') ?? ''), [advanced, setAdvanced] = useState(()=>new URLSearchParams(window.location.hash.split('?')[1]).get('coding')==='receipts'), paging = useCursorPages();
    const feed = useMemo(() => operationFeed(api), [api]), feedError = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
    const [related,setRelated] = useState(()=>new URLSearchParams(window.location.hash.split('?')[1] ?? ''));
    const materialId=related.get('materialId'),sourceId=related.get('sourceId');
    const identity=JSON.stringify([materialId,materialId?null:sourceId]);
    const [pagingIdentity,setPagingIdentity]=useState(identity);
    useEffect(()=>{if(pagingIdentity!==identity){paging.reset();setPagingIdentity(identity);}},[identity,pagingIdentity]);
    const query = new URLSearchParams({ state, limit: '10', ...pagingIdentity===identity&&paging.cursor ? { cursor: String(paging.cursor) } : {} });
    if(materialId)query.set('materialId',materialId);else if(sourceId)query.set('sourceId',sourceId);
    const { data, error, loading, refresh } = useResource<WorkActivityPage>(api, selected ? null : '/api/work-activity?' + query, 3000);
    useEffect(() => { const changed = () => {const query=new URLSearchParams(window.location.hash.split('?')[1]);setSelected(query.get('work')??'');setRelated(query);if(query.get('coding')==='receipts')setAdvanced(true);}; window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
    if (selected)
        return <WorkDetail key={selected} api={api} id={selected} onBack={() => { setSelected(''); const query=new URLSearchParams(window.location.hash.split('?')[1]??''); query.delete('work'); window.location.hash = '#/activity'+(query.size?'?'+query:''); }} onNavigate={onNavigate} onOpen={onOpen}/>;
    return <div className="activity-centre"><div className="activity-detail-toolbar"><button className="back-link" onClick={()=>onNavigate('overview')}><ArrowLeft size={14}/>{moteText('首页')}</button><button className="text-button" disabled={loading} onClick={refresh}>{moteText('刷新')}</button></div><div className="page-heading settings-heading activity-list-heading"><h1>{moteText('后台活动')}</h1></div>
  {(related.has('sourceId')||related.has('materialId'))&&<div className="related-activity-context"><span>{moteText('相关活动')}</span><p>{moteText('这里只列出已有稳定回执关联的活动，历史关联可能不完整。')}</p><a className="text-button" href="#/activity">{moteText('全部活动')}</a></div>}
  <nav className="section-tabs" aria-label={moteText('活动状态')}>{([['active', moteText("进行中")], ['attention', moteText("需要处理")], ['completed', moteText("已结束")]] as const).map(([key, label]) => <button key={key} aria-current={state === key ? 'page' : undefined} onClick={() => { setState(key); paging.reset(); }}>{moteText(label)}</button>)}</nav>
  {feedError !== undefined && <p role="status">{moteText('进度连接暂时中断，正在自动重连。')}</p>}{error !== undefined && <p className="notice error" role="alert">{errorMessage(error)} <button className="text-button" onClick={refresh}>{moteText('重试')}</button></p>}{loading && !data && <p role="status">{moteText('正在读取…')}</p>}
  <section className="activity-list" aria-label={moteText('工作列表')} aria-busy={loading}>{data?.items.map(work=><button className="activity-card" key={work.id} onClick={()=>{setSelected(work.id);window.location.hash='#/activity?'+new URLSearchParams({...Object.fromEntries(related),work:work.id});}}><span className="activity-symbol" aria-hidden="true">{activityKinds[work.kind]?.symbol}</span><span className="activity-card-content"><span className="activity-card-heading"><strong>{work.goal}</strong><WorkStateBadge state={work.state}/></span><WorkProgress progress={work.progress} compact/><span className="activity-row-bottom">{activityKinds[work.kind]&&<span className="activity-kind-tag">{moteText(activityKinds[work.kind].label)}</span>}{(work.branchCounts?.running??0)>0&&<small>{moteText('{0} 个工作分支正在进行',work.branchCounts!.running)}</small>}{work.artifacts.length>0&&<small>{work.artifacts.map(artifact=>artifact.title).join(' · ')}</small>}</span></span><time dateTime={work.updatedAt}>{dateTime(work.updatedAt)}</time><ChevronRight size={14}/></button>)}</section>
  {data && !data.items.length && <section className="panel empty"><h2>{moteText(materialId||sourceId?'未找到已关联活动':state === 'active' ? '目前没有正在进行的工作' : state === 'attention' ? '目前没有需要处理的工作' : '这里会显示已结束的工作')}</h2></section>}
  <ListPagination label={moteText('活动分页')} paging={paging} nextCursor={data?.nextCursor} count={data?.items.length ?? 0} loading={loading}/>
  <details className="panel activity-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>{moteText('高级')}</summary>{advanced && <><p>{moteText("这里是 Mote 的后台工作：理解资料、导入、整理记忆与生成洞察。手机和电脑的应用使用情况在「资料库 → 应用活动」。")}</p><p>{moteText('查看底层执行记录，排查依赖与失败原因。')}</p><button className="button subtle" onClick={() => onNavigate('processing')}>{moteText('技术执行记录')}</button><CodingReceiptPanel api={api}/></>}</details>
 </div>;
}
