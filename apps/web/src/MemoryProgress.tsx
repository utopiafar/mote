import { moteText } from '@mote/shared/i18n';
import {useEffect, useState} from 'react';
import {CheckCircle2, LoaderCircle, RefreshCw} from 'lucide-react';
import {type Api, errorMessage,dateTime,duration} from './api';

export interface MemoryJob {
  id: string;
  importJobId?: string;
  status: 'queued'|'running'|'completed'|'failed'|'waiting_for_model'|'cancelled'|'paused'|'pausing';
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
  queuePosition?:number;runningBatches?:number;pendingBatches?:number;lastSavedAt?:string;
  batches?: {id:string;index:number;status:string;attempts:number;memoryIds:string[];errorCode?:string;phase?:'extract'|'review';stage?:string;startedAt?:string;lastActivityAt?:string;validationFailures?:{at:string;code:string;phase:string;attempt?:number;details?:{candidateIndex?:number;spanIndex?:number}}[]}[];
  execution?: import('@mote/shared').ExecutionEnvelope;
}
export const memoryJobLabels: Record<MemoryJob['status'], string> = {
  paused:moteText('已暂停'),pausing:moteText('当前批次结束后暂停'),
  queued:moteText("等待提取记忆"), running:moteText("正在分批提取记忆"), completed:moteText("记忆提取完成"),
  failed:moteText("部分记忆提取需要重试"), waiting_for_model:moteText("等待配置模型"), cancelled:moteText("记忆提取已停止"),
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
        if(['queued','running','pausing'].includes(value.status)||(value.runningBatches??0)>0)timer=setTimeout(()=>void load(),2000);
      }catch(e){if(!controller.signal.aborted){setError(errorMessage(e));timer=setTimeout(()=>void load(),8000);}}
    }
    void load();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[api,id,revision]);
  return {job,error,reload:()=>setRevision(v=>v+1)};
}

export function MemoryProgress({job,onRetry,onView,busy=false,onAction}:{job:MemoryJob;onRetry?:()=>void;onView?:()=>void;busy?:boolean;onAction?:(action:'pause'|'resume'|'cancel')=>void}) {
  const running=['queued','running','pausing'].includes(job.status)||(job.runningBatches??0)>0;
  return <section className="memory-progress" aria-label={moteText("记忆处理进度")} aria-live="polite">
    <div className="workflow-line"><span className={'workflow-icon '+(job.status==='completed'?'done':'')}>{running?<LoaderCircle size={18} className="spin"/>:<CheckCircle2 size={18}/>}</span><div><strong>{memoryJobLabels[job.status]}</strong><p>{moteText("已完成")}{' '}{job.completedBatches} / {job.totalBatches}{' '}{moteText("批 · 生成")}{' '}{job.memoryIds.length}{' '}{moteText("条候选记忆")}{job.failedBatches>0?moteText(" · {0} 批失败", job.failedBatches):''}</p></div></div>
    {job.totalBatches>0&&<progress aria-label={moteText("记忆批次完成进度")} max={job.totalBatches} value={job.completedBatches}/>}
    <p className="muted">{moteText('执行中 {0} 批 · 等待 {1} 批',job.runningBatches??0,job.pendingBatches??0)}{job.status==='queued'&&(job.queuePosition?moteText(' · 等待执行名额，轮转位置 {0}',job.queuePosition):moteText(' · 等待调度'))}{job.lastSavedAt&&moteText(' · 最近保存 {0}',dateTime(job.lastSavedAt))}</p>
    {job.status==='completed'&&!job.memoryIds.length&&<p>{moteText('已完成，本次没有发现需要新增的记忆。')}</p>}
    {job.status==='cancelled'&&(job.runningBatches??0)>0&&<p>{moteText('已取消剩余批次，当前批次完成后停止。已保存结果保留。')}</p>}
    {job.batches?.filter(batch=>batch.status==='running').map(batch=><div className="notice memory-batch-status" key={batch.id}><strong>{moteText('第 {0} 批',batch.index+1)} · {batch.phase==='review'?moteText('独立审核'):moteText('提取记忆')}</strong><p>{({starting:moteText('准备中'),model:moteText('等待模型响应'),tool:moteText('读取证据'),validating:moteText('校验结果')} as Record<string,string>)[batch.stage??'']??batch.stage}</p><small>{batch.startedAt&&moteText('本批次已耗时 {0}',duration(Date.now()-Date.parse(batch.startedAt)))}{batch.lastActivityAt&&moteText(' · 最后活动 {0}',dateTime(batch.lastActivityAt))}</small>{batch.lastActivityAt&&Date.now()-Date.parse(batch.lastActivityAt)>120000&&<p>{moteText('较长时间未收到新活动；任务仍在等待，不代表已有新结果。')}</p>}</div>)}
    {onAction&&<div className="source-toolbar">{['running','queued'].includes(job.status)&&<button className="button subtle" disabled={busy} onClick={()=>onAction('pause')}>{moteText('当前批次结束后暂停')}</button>}{['paused','pausing'].includes(job.status)&&<button className="button" disabled={busy} onClick={()=>onAction('resume')}>{moteText('继续整理')}</button>}{!['completed','cancelled','failed'].includes(job.status)&&<button className="button subtle" disabled={busy} onClick={()=>onAction('cancel')}>{moteText('取消剩余批次')}</button>}</div>}
    {job.batches?.some(batch=>batch.validationFailures?.length)&&<details className="run-details"><summary>{moteText('校验与重试记录')}</summary>{job.batches.filter(batch=>batch.validationFailures?.length).map(batch=><div key={batch.id}><strong>{moteText('第 {0} 批',batch.index+1)}</strong>{batch.validationFailures!.map((failure,index)=><p key={index}>{dateTime(failure.at)} · {failure.phase==='review'?moteText('审核'):moteText('提取')} · <code>{failure.code}</code>{failure.attempt&&moteText(' · 第 {0} 次尝试',failure.attempt)}{failure.details?.candidateIndex!==undefined&&moteText(' · 候选 {0}',failure.details.candidateIndex+1)}{failure.details?.spanIndex!==undefined&&moteText(' · 引用 {0}',failure.details.spanIndex+1)}</p>)}</div>)}</details>}
    {job.skippedChunks>0&&<p className="muted">{moteText("有")}{' '}{job.skippedChunks}{' '}{moteText("个片段已处理过或没有可提取的正文，本次未重复处理。原始资料仍可查看。")}</p>}
    {job.status==='waiting_for_model'&&<p className="muted">{moteText("在设置中配置模型后，可从这里继续。")}</p>}
    <div className="source-toolbar">{(job.status==='failed'||job.status==='waiting_for_model')&&onRetry&&<button className="button" disabled={busy} onClick={onRetry}><RefreshCw size={14}/>{moteText("继续提取记忆")}</button>}{job.memoryIds.length>0&&onView&&<button className="button subtle" onClick={onView}>{moteText("查看候选记忆")}</button>}</div>
    {job.errorCode&&<details className="run-details"><summary>{moteText("处理详情")}</summary><code>{job.errorCode}</code></details>}
  </section>;
}
