import {CheckCircle2,Clock3,LoaderCircle,AlertCircle} from 'lucide-react';
import {dateTime,type Answer} from './api';
export interface InsightRun {id:string;status:'running'|'completed'|'failed';createdAt:string;updatedAt:string;scope:{after?:string;before?:string;deviceId?:string};events:{stage:'starting'|'model'|'tool'|'validating';at:string;tool?:string;count?:number}[];error?:{code:string;message:string};result?:Answer}
const tools:Record<string,string>={search_context:'检索上下文',timeline:'读取时间线',evidence:'展开原始证据',activity:'核对采样时长',media_activity:'读取媒体采样',devices:'读取设备信息',sources:'查看资料来源',source_items:'读取来源记录',source_history:'查看历史版本',memories:'检索记忆',file_chunks:'读取文件片段'};
const stages={starting:'正在准备回顾',model:'模型正在分析资料并生成报告',tool:'模型继续分析已读取的资料',validating:'正在校验报告与来源引用'};
export function InsightProgress({run,pollError,elapsed,onRetry,onResume}:{run:InsightRun;pollError:string;elapsed:number;onRetry:()=>void;onResume:()=>void}){
  const running=run.status==='running';
  return <section className="panel insight-progress" aria-label="回顾运行状态"><div className="section-heading"><div className="progress-title">{running?<LoaderCircle className="spin" size={20}/>:run.status==='completed'?<CheckCircle2 size={20}/>:<AlertCircle size={20}/>}<h2>{running?stages[run.events.at(-1)?.stage??'starting']:run.status==='completed'?'回顾已完成':'回顾未完成'}</h2></div><span className="badge muted">{Math.floor(elapsed/60)} 分 {elapsed%60} 秒</span></div>
    <p role="status">{running?'可离开或刷新页面，回来后仍能查看进度。':run.error?.message??'报告已归档，可在洞察历史中查看。'}</p>
    <p className="field-note">{run.scope.after?`范围：${dateTime(run.scope.after)}${run.scope.before?' — '+dateTime(run.scope.before):' 至现在'}`:'范围：全部已归档资料'} · 最后更新 {dateTime(run.updatedAt)}</p>
    {pollError&&<div className="error-banner" role="alert">进度连接暂时中断：{pollError}。服务器可能仍在运行，正在自动重连。<button type="button" className="button" onClick={onResume}>重新连接</button></div>}
    <ol className="insight-steps">{run.events.map((event,index)=><li key={index}><Clock3 size={14}/><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.stage==='tool'?`${tools[event.tool??'']??event.tool??'读取资料'} · 返回 ${event.count??0} 项`:stages[event.stage]}</span></li>)}</ol>
    {run.status==='failed'&&<button type="button" className="button primary" onClick={onRetry}>调整范围后重试</button>}
    <p className="field-note">这里展示实际运行阶段与检索操作；报告中的结论附有可打开的原文引用。</p>
  </section>;
}
