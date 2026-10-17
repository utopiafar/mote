import {useEffect} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {failureMessage} from './failure-message';

type Task={id:string;state:string;error?:string;failure?:Parameters<typeof failureMessage>[0];result?:{memoryIds?:string[]}};
export type ScopedMemoryJob={id:string;state:string;current:boolean;phase?:string;automatic?:boolean;batches:{id:string;state:string;coverage?:unknown}[];tasks:Record<string,Task>};
export function scopedMemoryState(job:ScopedMemoryJob){
 if(['cancelled','deleted','paused'].includes(job.state))return job.state;
 if(job.state==='awaiting_context')return 'needs_input';
 const states=Object.values(job.tasks).map(task=>task.state);
 if(states.includes('failed'))return 'failed';if(states.includes('blocked'))return 'blocked';if(states.includes('stale'))return 'stale';
 if(states.length&&states.every(state=>state==='succeeded')&&job.state==='committed')return 'succeeded';
 if(!job.current)return 'stale';
 if(states.includes('running'))return 'running';return 'waiting';
}
export const scopedMemoryLabel=(job:ScopedMemoryJob)=>job.phase==='integrate'?({waiting:moteText('等待执行'),running:moteText('正在整理'),succeeded:moteText('已完成'),failed:moteText('整理失败'),blocked:moteText('需要处理'),needs_input:moteText('需要处理'),stale:moteText('资料已更新，本次结果失效'),cancelled:moteText('已取消'),deleted:moteText('已删除'),paused:moteText('已暂停')} as Record<string,string>)[scopedMemoryState(job)]:({waiting:moteText('等待提取记忆'),running:moteText('正在分批提取记忆'),succeeded:moteText('记忆提取完成'),failed:moteText('部分记忆提取需要重试'),blocked:moteText('需要处理'),needs_input:moteText('需要处理'),stale:moteText('资料已更新，本次结果失效'),cancelled:moteText('记忆提取已停止'),deleted:moteText('已删除'),paused:moteText('已暂停')} as Record<string,string>)[scopedMemoryState(job)];
export function scopedMemoryResults(job:ScopedMemoryJob){return [...new Set(Object.entries(job.tasks).filter(([stage,task])=>(stage.startsWith('publish')||stage==='correct')&&task.state==='succeeded').flatMap(([,task])=>task.result?.memoryIds??[]))];}
export function useScopedMemoryJob(api:Api,id?:string,revision?:unknown){
 const path=api.connection?.mode==='web'&&id?'/api/memory/jobs/'+encodeURIComponent(id):null,read=useResource<ScopedMemoryJob>(api,path,undefined,revision);
 const active=read.data&&['waiting','running'].includes(scopedMemoryState(read.data));
 useEffect(()=>path&&active?resources(api).get(path).poll(2000):undefined,[api,path,active]);return read;
}
/** The scoped receipt contains persisted batches and tasks, rather than the
 * legacy input-plan counters. Render those facts without inventing counters. */
export function ScopedMemoryProgress({job,busy=false,onAction,onView}:{job:ScopedMemoryJob;busy?:boolean;onAction:(action:'pause'|'resume'|'cancel'|'retry')=>void;onView?:(id:string)=>void}){
 const state=scopedMemoryState(job),results=scopedMemoryResults(job),failed=Object.values(job.tasks).filter(task=>['failed','blocked','stale'].includes(task.state));
 return <section className="memory-progress" aria-label={moteText('记忆处理进度')} aria-live="polite"><div className="workflow-line"><div><strong>{scopedMemoryLabel(job)}</strong><p>{job.batches.filter(batch=>batch.state==='committed').length} / {job.batches.length} · {moteText('已生成的批次')}</p></div></div>
 {!job.current&&<p className="notice">{moteText('输入版本已变化；任务完成记录保留，请打开记忆核对当前可读版本。')}</p>}
 {state==='succeeded'&&<p>{moteText('生成 {0} 条记忆',results.length)}</p>}
 {failed.map(task=><p key={task.id} role="status">{failureMessage(task.failure??task.error??task.state)}</p>)}
 <details className="run-details"><summary>{moteText('处理详情')}</summary>{Object.entries(job.tasks).map(([stage,task])=><p key={task.id}><code>{stage}</code> · {task.state}{task.error?' · '+task.error:''}</p>)}<code>{job.id}</code></details>
 <div className="source-toolbar">{['waiting','running'].includes(state)&&<button className="button subtle" disabled={busy} onClick={()=>onAction('pause')}>{moteText('当前批次结束后暂停')}</button>}{state==='paused'&&<button className="button" disabled={busy} onClick={()=>onAction('resume')}>{moteText('继续整理')}</button>}{['failed','blocked'].includes(state)&&<button className="button" disabled={busy} onClick={()=>onAction('retry')}>{moteText('重新检查未完成方案')}</button>}{!['succeeded','cancelled','deleted'].includes(state)&&<button className="button subtle" disabled={busy} onClick={()=>onAction('cancel')}>{moteText('取消未完成方案')}</button>}{results[0]&&onView&&<button className="button subtle" onClick={()=>onView(results[0])}>{moteText('查看记忆')}</button>}</div>
 </section>;
}
