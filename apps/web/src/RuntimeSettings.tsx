import {useResource} from './useResource';
import {resources} from './resource-cache';
import {ApiError} from './api';
import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {useUnsavedChanges} from './unsaved';
type Values={interactiveConcurrency:number;agentConcurrency:number;llmConcurrency:number;memoryConcurrency:number}|{enabled:boolean;debug:boolean;traceEnabled:boolean;level:string};
export function RuntimeSettings({api,kind,onApplied}:{api:Api;kind:'execution'|'diagnostics';onApplied?:()=>void}){
  const [draft,setDraft]=useState<Values>(),[saved,setSaved]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);
  useUnsavedChanges(dirty);
  const path='/api/'+kind+'-settings';
  const read=useResource<Values>(api,path);
  useEffect(()=>{setDraft(undefined);setDirty(false);setSaved('');setError('');},[api,path]);
  useEffect(()=>{if(read.data&&!dirty){const {queues:_,modelQuotaUnit:__,...settings}=read.data as Values&{queues?:unknown;modelQuotaUnit?:unknown};setDraft(settings);}if(read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status)){setDraft(undefined);setDirty(false);}},[api,path,read.data,read.error]);
  const change=(key:string,value:unknown)=>{setDraft(current=>({...current,[key]:value}) as Values);setDirty(true);setSaved('');};
  async function save(){setBusy(true);setError('');try{const value=await api.request<Values>(path,{method:'PUT',body:JSON.stringify(draft)});setDraft(value);setDirty(false);setSaved(moteText('已保存，立即生效。'));resources(api).invalidate(key=>key===path);onApplied?.();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  return <section className="panel"><div className="section-heading"><div><h2>{kind==='execution'?moteText('执行并发'):moteText('诊断偏好')}</h2><p>{moteText('保存后立即生效，重启后保留。')}</p></div></div>{draft&&<form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy}>
    {'agentConcurrency' in draft?<><div className="preference-grid">{([['interactiveConcurrency','交互问答并发',8],['agentConcurrency','后台 Agent 并发',64],['llmConcurrency','后台 Harness 并发',64],['memoryConcurrency','记忆批次并发',16]] as const).map(([key,label,max])=><label key={key}>{moteText(label)}<input type="number" min={1} max={max} step={1} required value={draft[key]} onChange={e=>change(key,e.target.valueAsNumber)}/></label>)}</div><p className="fine-print">{moteText('超出名额的工作会排队。降低上限不会中断正在执行的任务。LLM 名额覆盖一次模型运行及其工具循环；Codex 内部请求不可单独计量。')}</p></>:<><label className="preference-toggle"><span>{moteText('记录运行诊断')}</span><input type="checkbox" checked={draft.enabled} onChange={e=>change('enabled',e.target.checked)}/></label><label>{moteText('日志详细程度')}<select value={draft.level} onChange={e=>change('level',e.target.value)}>{['silent','error','warn','info','debug'].map(level=><option key={level}>{level}</option>)}</select></label><label className="preference-toggle"><span>{moteText('启用调试模式')}</span><input type="checkbox" checked={draft.debug} onChange={e=>change('debug',e.target.checked)}/></label><label className="preference-toggle"><span>{moteText('记录详细 Agent 过程')}</span><input type="checkbox" checked={draft.traceEnabled} onChange={e=>change('traceEnabled',e.target.checked)}/></label><p className="fine-print">{moteText('详细过程与运行日志使用相同的 JSON 行格式，包含 prompt、上下文、模型输出和工具过程，可能包含个人内容。关闭后立即停止新增详细记录。')}</p></>}
    <button className="button primary" disabled={!dirty||busy}>{busy?moteText('保存中…'):moteText('保存并应用')}</button></fieldset></form>}{saved&&<p role="status">{saved}</p>}{Boolean(error||read.error)&&<p className="notice error" role="alert">{error||errorMessage(read.error)}</p>}</section>;
}

export function ExecutionQueueOverview({api}:{api:Api}){
 const {data,error}=useResource<{queues:{agents:{active:number;waiting:number;limit:number};llm:{active:number;waiting:number;limit:number}}}>(api,'/api/execution-settings',5000),queues=data?.queues;
 return <section className="notice execution-queue-overview" aria-label={moteText('执行队列')}><strong>{moteText('执行队列')}</strong>{queues&&<p>{moteText('Agent：执行中 {0} / {1}，排队 {2}',queues.agents.active,queues.agents.limit,queues.agents.waiting)}<br/>{moteText('LLM：执行中 {0} / {1}，排队 {2}',queues.llm.active,queues.llm.limit,queues.llm.waiting)}</p>}{error!==undefined&&<p role="alert">{errorMessage(error)}</p>}</section>;
}
