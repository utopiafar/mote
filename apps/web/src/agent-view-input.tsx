import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {recordedContext,recordedReads,traceLabel,type TraceEvent,type InitialContext} from './agent-view-trace';

type Scope={deviceId?:string;after?:string;before?:string};
type Preview={kind:string;context:InitialContext;system:string;tools:string[];toolDefinitions:unknown;modelCalls:number};
function ContextContents({context}:{context:InitialContext}){
 return <div className="agent-initial-content">
  <dl className="agent-context-fields"><dt>{moteText('当前问题')}</dt><dd>{context.request||moteText('尚未输入问题')}</dd><dt>{moteText('时间与设备范围')}</dt><dd>{context.selectedTimeRange?.after??'…'} → {context.selectedTimeRange?.before??'…'} · {context.selectedDeviceId??moteText('全部设备')} · {context.timeZone}</dd></dl>
  <h3>{moteText('启动时提供的记忆线索')} · {context.untrustedMemoryLeads?.length??0}</h3>
  {context.untrustedMemoryLeads?.map(memory=><article className="agent-proof" key={memory.id}><span className="badge green">{moteText('启动时已提供')}</span><h4>{memory.title}</h4><div className="agent-body">{memory.statement}</div>{memory.uncertainty&&<p>{moteText('不确定性')} · {memory.uncertainty}</p>}<code>{memory.id}</code></article>)}
  {!context.untrustedMemoryLeads?.length&&<p>{moteText('此次没有提供记忆线索。目录与原文仍可按需读取。')}</p>}
  {context.conversation&&<p>{moteText('已提供 {0} 轮对话，省略 {1} 轮。',context.conversation.turns?.length??0,context.conversation.omittedTurns??0)}</p>}
  {!!context.untrustedEvidence?.length&&<p>{moteText('启动时已提供 {0} 条指定证据。',context.untrustedEvidence.length)}</p>}
 </div>;
}
export function StartupPreview({api,scope}:{api:Api;scope:Scope}){
 const [question,setQuestion]=useState(''),[submitted,setSubmitted]=useState(''),[refresh,setRefresh]=useState(0),[state,setState]=useState<{data?:Preview;error?:unknown;loading:boolean}>({loading:true});
 const scopeKey=JSON.stringify(scope);
 useEffect(()=>{const controller=new AbortController();setState({loading:true});
  void api.request<Preview>('/api/agent-view/startup',{method:'POST',body:JSON.stringify({question:submitted,...JSON.parse(scopeKey),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}),signal:controller.signal}).then(data=>{if(!controller.signal.aborted)setState({data,loading:false});}).catch(error=>{if(!controller.signal.aborted)setState({error,loading:false});});
  return ()=>controller.abort();
 },[api,scopeKey,submitted,refresh]);
 return <section className="panel panel-pad agent-startup"><h2>{moteText('一次新对话的首次上下文')}</h2><p>{moteText('用当前资料预览一次新对话，不调用模型。实际运行以当时记录的输入为准。')}</p>
  <form className="agent-preview-form" onSubmit={e=>{e.preventDefault();setSubmitted(question);setRefresh(v=>v+1);}}><label>{moteText('想问的问题')}<input maxLength={4000} value={question} onChange={e=>setQuestion(e.target.value)} placeholder={moteText('输入问题，看看启动时会带上哪些记忆线索')}/></label><button className="button" type="submit">{moteText('预览首次上下文')}</button></form>
  <div className="agent-startup-rules"><p>{moteText('默认包含：系统规则、只读工具说明、当前问题、时间与设备范围，以及最多 5 条记忆线索。')}</p><p>{moteText('已有对话会按预算带入历史或工作摘要；此处预览的是没有历史的新对话。')}</p><p>{moteText('完整目录、文件正文和原图需要按需读取，原图还受独立授权控制。')}</p></div>
  {state.loading&&<p role="status">{moteText('正在读取…')}</p>}{state.error!==undefined&&<p role="alert">{errorMessage(state.error)} <button className="text-button" onClick={()=>setRefresh(v=>v+1)}>{moteText('重试')}</button></p>}
  {state.data&&<><ContextContents context={state.data.context}/><details><summary>{moteText('可用的只读工具')} · {state.data.tools.length}</summary><div className="agent-tool-list">{state.data.tools.map(tool=><code key={tool}>{tool}</code>)}</div><pre className="feature-json">{JSON.stringify(state.data.toolDefinitions,null,2)}</pre></details><details><summary>{moteText('系统规则与工具')}</summary><pre className="feature-json">{state.data.system}</pre></details><details><summary>{moteText('查看上下文结构')}</summary><pre className="feature-json">{JSON.stringify(state.data.context,null,2)}</pre></details></>}
 </section>;
}
export function RecordedInput({api,runId,setRunId}:{api:Api;runId:string;setRunId:(id:string)=>void}){
 const [afterSeq,setAfterSeq]=useState(0);
 const runs=useResource<{items:{runId:string;at:string;type:string;firstSeq:number}[];recording:{enabled:boolean}}>(api,'/api/agent-view/runs');
 const page=useResource<{items:TraceEvent[];nextSeq:number;oldestSeq:number;recording:{enabled:boolean}}>(api,`/api/agent-view/events?afterSeq=${afterSeq}&runId=${encodeURIComponent(runId)}`);
 const choose=(id:string)=>{setRunId(id);setAfterSeq(Math.max(0,(runs.data?.items.find(run=>run.runId===id)?.firstSeq??1)-1));};
 return <section className="panel panel-pad agent-recorded"><h2>{moteText('实际输入与读取轨迹')}</h2><p>{moteText('这里只展示已记录的输入和工具事件；未开启追踪或已过保留期的输入无法还原。')}</p>
  <div className="agent-run-selection"><label>{moteText('最近保留的运行')}<select value={runs.data?.items.some(run=>run.runId===runId)?runId:''} onChange={e=>choose(e.target.value)}><option value="">{moteText('全部保留事件')}</option>{runs.data?.items.map(run=><option key={run.runId} value={run.runId}>{run.at} · {run.runId}</option>)}</select></label><label>{moteText('运行编号')}<input value={runId} onChange={e=>choose(e.target.value)}/></label></div>
  {page.data&&<p>{page.data.recording.enabled?moteText('输入追踪已开启'):moteText('输入追踪未开启')} · {moteText('仅显示已保留的事件，不能据此认定完整读取范围。')}</p>}
  {page.data&&afterSeq<page.data.oldestSeq-1&&<p>{moteText('更早的事件已不在保留范围内。')}</p>}
  {runs.error!==undefined&&<p role="alert">{errorMessage(runs.error)} <button onClick={runs.refresh}>{moteText('重试')}</button></p>}{page.error!==undefined&&<p role="alert">{errorMessage(page.error)} <button onClick={page.refresh}>{moteText('重试')}</button></p>}
  <ol className="agent-trace-list">{page.data?.items.map(item=>{const context=recordedContext(item),reads=recordedReads(item);return <li key={item.seq}><div className="agent-trace-heading"><strong>{traceLabel(item.trace?.type??'')}</strong>{item.trace?.tool&&<code>{item.trace.tool}</code>}<time>{item.at}</time></div>
   {item.trace?.type==='context.assembled'&&<span className="badge green">{moteText('启动时已提供')}</span>}{item.trace?.type==='tool.completed'&&<span className="badge muted">{item.trace.status==='failed'?moteText('读取失败'):moteText('工具调用已完成')}</span>}
   {(item.truncated||item.trace?.truncated)&&<p>{moteText('记录已截断，不能还原完整输入。')}</p>}{context&&<ContextContents context={context}/>}
   {reads.map((read,index)=><details key={index}><summary>{read.title??read.ref??read.id??moteText('条目内容')} · {moteText('本次返回内容')}</summary>{read.offset!==undefined&&<p className="fine-print">{moteText('已展开 {0}–{1} / {2} 个字符',read.offset,read.offset+read.text.length,read.total??read.offset+read.text.length)}</p>}<div className="agent-body">{read.text}</div></details>)}
   <details><summary>{moteText('查看记录内容')}</summary><pre className="feature-json">{JSON.stringify(item.trace?.payload,null,2)}</pre></details>
  </li>;})}</ol>
  {page.data&&!page.data.items.length&&<p>{moteText('此页没有已保留的模型输入或工具事件。')}</p>}
  <div className="processing-actions"><button className="button" onClick={()=>{runs.refresh();page.refresh();}}>{moteText('刷新')}</button>{afterSeq>0&&<button className="button" onClick={()=>setAfterSeq(0)}>{moteText('返回第一页')}</button>}{page.data&&page.data.nextSeq>afterSeq&&<button className="button" onClick={()=>setAfterSeq(page.data!.nextSeq)}>{moteText('下一页')}</button>}</div>
 </section>;
}
