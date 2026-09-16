import {useEffect, useState} from 'react';
import {CheckCircle2, LoaderCircle, RefreshCw} from 'lucide-react';
import {type Api, errorMessage} from './api';

export interface MemoryJob {
  id: string;
  importJobId?: string;
  status: 'queued'|'running'|'completed'|'failed'|'waiting_for_model'|'cancelled';
  createdAt: string;
  updatedAt: string;
  evidenceIds: string[];
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  skippedChunks: number;
  memoryIds: string[];
  errorCode?: string;
  skillVersion: string;
  batches?: {id:string;index:number;status:string;attempts:number;memoryIds:string[];errorCode?:string}[];
}
export const memoryJobLabels: Record<MemoryJob['status'], string> = {
  queued:'等待提取记忆', running:'正在分批提取记忆', completed:'记忆提取完成',
  failed:'部分记忆提取需要重试', waiting_for_model:'等待配置模型', cancelled:'记忆提取已停止',
};

export function useMemoryJob(api:Api, id?:string) {
  const [job,setJob]=useState<MemoryJob|null>(null);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    setJob(null);setError('');
    if(!id)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function load(){
      try{
        const value=await api.request<MemoryJob>('/api/memory-jobs/'+encodeURIComponent(id!),{signal:controller.signal});
        if(controller.signal.aborted)return;
        setJob(value);setError('');
        if(value.status==='queued'||value.status==='running')timer=setTimeout(()=>void load(),2000);
      }catch(e){if(!controller.signal.aborted){setError(errorMessage(e));timer=setTimeout(()=>void load(),8000);}}
    }
    void load();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[api,id,revision]);
  return {job,error,reload:()=>setRevision(v=>v+1)};
}

export function MemoryProgress({job,onRetry,onView,busy=false}:{job:MemoryJob;onRetry?:()=>void;onView?:()=>void;busy?:boolean}) {
  const running=job.status==='queued'||job.status==='running';
  return <section className="memory-progress" aria-label="记忆处理进度" aria-live="polite">
    <div className="workflow-line"><span className={'workflow-icon '+(job.status==='completed'?'done':'')}>{running?<LoaderCircle size={18} className="spin"/>:<CheckCircle2 size={18}/>}</span><div><strong>{memoryJobLabels[job.status]}</strong><p>已完成 {job.completedBatches} / {job.totalBatches} 批 · 生成 {job.memoryIds.length} 条候选记忆{job.failedBatches>0?` · ${job.failedBatches} 批失败`:''}</p></div></div>
    {job.totalBatches>0&&<progress aria-label="记忆批次完成进度" max={job.totalBatches} value={job.completedBatches}/>}
    {job.skippedChunks>0&&<p className="muted">有 {job.skippedChunks} 个片段已处理过或没有可提取的正文，本次未重复处理。原始资料仍可查看。</p>}
    {job.status==='waiting_for_model'&&<p className="muted">在设置中配置模型后，可从这里继续。</p>}
    <div className="source-toolbar">{(job.status==='failed'||job.status==='waiting_for_model')&&onRetry&&<button className="button" disabled={busy} onClick={onRetry}><RefreshCw size={14}/>继续提取记忆</button>}{job.memoryIds.length>0&&onView&&<button className="button subtle" onClick={onView}>查看候选记忆</button>}</div>
    {job.errorCode&&<details className="run-details"><summary>处理详情</summary><code>{job.errorCode}</code></details>}
  </section>;
}
