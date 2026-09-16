import {useEffect,useState} from 'react';
import {Check,Layers3,LoaderCircle,RefreshCw,Sparkles,Trash2} from 'lucide-react';
import {AnswerMarkdown} from './AnswerMarkdown';
import {ArchivedFileButton} from './ArchivedFileButton';
import {MemoryProgress,useMemoryJob,type MemoryJob} from './MemoryProgress';
import {type Api,errorMessage,dateTime,type Range,type FileEvidence} from './api';

interface MemoryEvidence {
  id:string;sourceId?:string;externalId?:string;revision?:string;capturedAt:string;receivedAt:string;
  recordedAt?:string;occurredAt?:string;fileId?:string;path?:string;uri?:string;timeBasis?:string;
  contentRole?:string;offset?:number;length?:number;quote?:string;contentHash:string;
  fileEvidence?:FileEvidence;
}
interface Memory {
  id:string;title:string;statement?:string;uncertainty?:string;evidenceIds?:string[];evidenceCount?:number;evidence?:MemoryEvidence[];
  status:string;createdAt:string;updatedAt?:string;model?:string;skillVersion?:string;staleReason?:string;
}
const labels:Record<string,string>={proposed:'待确认',published:'已确认',stale:'需要重验'};
export function Memories({api,range,onOpen,refreshVersion=0}:{refreshVersion?:number;api:Api;range:Range;onOpen:(id:string)=>void}){
  const [items,setItems]=useState<Memory[]>([]),[detail,setDetail]=useState<Memory|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[filter,setFilter]=useState('all'),[confirmDelete,setConfirmDelete]=useState(false);
  const [jobId,setJobId]=useState<string>(),[jobs,setJobs]=useState<MemoryJob[]>([]),[revision,setRevision]=useState(0);
  const {job,error:jobError,reload:reloadJob}=useMemoryJob(api,jobId);
  function refresh(){setRevision(value=>value+1);}
  useEffect(()=>{
    const controller=new AbortController();
    void api.request<{items:Memory[]}>('/api/memories?includeStale=true&limit=100',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setItems(value.items);setLoading(false);}}).catch(e=>{if(!controller.signal.aborted){setError(errorMessage(e));setLoading(false);}});
    void api.request<{items:MemoryJob[]}>('/api/memory-jobs',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setJobs(value.items);setJobId(current=>current??value.items.find(item=>['queued','running','failed','waiting_for_model'].includes(item.status))?.id);}}).catch(()=>{});
    return ()=>controller.abort();
  },[api,revision,refreshVersion]);
  useEffect(()=>{if(job?.status==='completed'||job?.status==='failed')refresh();},[job?.id,job?.status]);
  async function extract(){
    setBusy(true);setError('');
    try{const result=await api.request<MemoryJob>('/api/memory-jobs',{method:'POST',body:JSON.stringify({...range,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})});setJobId(result.id);reloadJob();refresh();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function open(id:string){setError('');setConfirmDelete(false);try{setDetail(await api.request<Memory>('/api/memories/'+encodeURIComponent(id)));}catch(e){setError(errorMessage(e));}}
  async function publish(){if(!detail)return;setBusy(true);setError('');try{setDetail(await api.request<Memory>('/api/memories/'+encodeURIComponent(detail.id)+'/publish',{method:'POST'}));refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function remove(){if(!detail)return;setBusy(true);setError('');try{await api.request('/api/memories/'+encodeURIComponent(detail.id),{method:'DELETE'});setDetail(null);setConfirmDelete(false);refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function retry(){if(!job)return;setBusy(true);setError('');try{await api.request('/api/memory-jobs/'+encodeURIComponent(job.id)+'/retry',{method:'POST'});reloadJob();refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  const visible=items.filter(item=>filter==='all'||item.status===filter);
  const evidence:MemoryEvidence[]=detail?.evidence?.length?detail.evidence:(detail?.evidenceIds??[]).map(id=>({id,capturedAt:detail!.createdAt,receivedAt:detail!.createdAt,contentHash:''}));
  return <section className="memories-page"><div className="page-heading split-heading"><div><div className="eyebrow">有依据，才值得记住</div><h1>记忆</h1><p>从资料中提取可复用的事实与经验。每条记忆都能回到原始证据，由你确认。</p></div><button className="button primary" disabled={busy||job?.status==='running'||job?.status==='queued'} onClick={()=>void extract()}>{busy?<LoaderCircle size={16} className="spin"/>:<Sparkles size={16}/>}提取当前范围的记忆</button></div>
    {error&&<div className="error-banner" role="alert">{error}</div>}{jobError&&<div className="error-banner" role="alert">记忆进度暂时无法更新：{jobError}</div>}
    {job&&<MemoryProgress job={job} onRetry={()=>void retry()} busy={busy}/>}
    {jobs.length>0&&<details className="memory-job-history"><summary>提取记录（{jobs.length}）</summary><div className="evidence-buttons">{jobs.map(item=><button className="button subtle" key={item.id} onClick={()=>setJobId(item.id)}>{dateTime(item.createdAt)} · {item.memoryIds.length} 条候选</button>)}</div></details>}
    <nav className="segmented-nav memory-filters" aria-label="记忆状态">{[['all','全部'],['proposed','待确认'],['published','已确认'],['stale','需要重验']].map(([id,label])=><button key={id} className={filter===id?'active':''} onClick={()=>setFilter(id)}>{label}<span>{items.filter(item=>id==='all'||item.status===id).length}</span></button>)}</nav>
    <div className="workspace-layout"><aside className="workspace-list" aria-label="记忆列表"><div className="workspace-list-heading"><h2>{filter==='all'?'全部记忆':labels[filter]}</h2><button className="icon-button" aria-label="刷新记忆" onClick={refresh}><RefreshCw size={15}/></button></div>{loading&&<p className="muted">正在读取…</p>}{!loading&&!visible.length&&<p className="muted">这里还没有记忆。导入资料后，可以开始提取。</p>}{visible.map(item=><button className={'workspace-select '+(detail?.id===item.id?'active':'')} key={item.id} onClick={()=>void open(item.id)}><strong>{item.title}</strong><span className={'status-label '+(item.status==='stale'?'attention':'')}>{labels[item.status]||item.status}</span><small>{dateTime(item.createdAt)} · {item.evidenceCount??item.evidenceIds?.length??0} 条证据</small></button>)}</aside>
    <div className="workspace-content">{detail?<article className="panel memory-detail"><div className="section-heading"><div><span className={'status-label '+(detail.status==='stale'?'attention':'')}>{labels[detail.status]||detail.status}</span><h2>{detail.title}</h2></div></div>
      <AnswerMarkdown answer={{answer:detail.statement??'',runId:detail.id,trace:[],citations:evidence.map(item=>({id:item.id,capturedAt:item.capturedAt,appName:item.path||'原始证据',excerpt:item.quote??''}))}} onOpen={onOpen}/>
      <div className="review-notes"><h3>{detail.status==='stale'?'证据发生了变化':'判断的边界'}</h3><p>{detail.status==='stale'?'来源已更新或移除，旧记忆需要重新核对。':(detail.uncertainty||'模型未补充不确定性；确认前请核对下方证据。')}</p></div>
      <section className="memory-evidence"><h3>支持这条记忆的证据</h3>{evidence.map((item,index)=><article className="memory-evidence-item" key={item.id+':'+index}><button className="evidence-card" onClick={()=>onOpen(item.id)}><span className="evidence-number">{index+1}</span><div><strong>{item.path||'查看原始记录'}</strong><small>{dateTime(item.occurredAt||item.recordedAt||item.capturedAt)}</small>{item.quote&&<p>{item.quote}</p>}</div></button><div className="evidence-meta">{item.fileId&&<ArchivedFileButton api={api} id={item.fileId} name={item.path?.split('/').pop()}/>}<details><summary>来源与定位</summary><dl>{item.sourceId&&<><dt>来源</dt><dd>{item.sourceId}</dd></>}{item.externalId&&<><dt>原始记录</dt><dd>{item.externalId}</dd></>}{item.revision&&<><dt>来源版本</dt><dd>{item.revision}</dd></>}{item.uri&&<><dt>原件位置</dt><dd>{item.uri}</dd></>}<dt>观察时间</dt><dd>{dateTime(item.capturedAt)}</dd>{item.receivedAt&&<><dt>归档时间</dt><dd>{dateTime(item.receivedAt)}</dd></>}{item.offset!==undefined&&<><dt>引用片段</dt><dd>从第 {item.offset+1} 个字符开始{item.length!==undefined?`，共 ${item.length} 个字符`:''}</dd></>}</dl></details></div></article>)}</section>
      <div className="memory-actions">{detail.status==='proposed'&&<button className="button primary" disabled={busy} onClick={()=>void publish()}><Check size={16}/>确认这条记忆</button>}{confirmDelete?<><span className="muted">删除这条记忆？原始资料仍保留。</span><button className="button danger" disabled={busy} onClick={()=>void remove()}>确认删除</button><button className="button subtle" onClick={()=>setConfirmDelete(false)}>取消</button></>:<button className="button subtle" disabled={busy} onClick={()=>setConfirmDelete(true)}><Trash2 size={14}/>删除记忆</button>}</div>
      <details className="run-details"><summary>生成信息</summary><dl><dt>生成时间</dt><dd>{dateTime(detail.createdAt)}</dd><dt>模型</dt><dd>{detail.model||'未记录'}</dd>{detail.skillVersion&&<><dt>Skill 版本</dt><dd>{detail.skillVersion}</dd></>}</dl><p className="muted">这是从原始资料中提取的模型判断。</p></details>
    </article>:<div className="panel workspace-empty"><Layers3 size={32}/><h2>把有用的事实和经验，留给下一次。</h2><p>选择一条记忆，查看内容、来源和判断的边界。</p></div>}</div></div>
  </section>;
}
