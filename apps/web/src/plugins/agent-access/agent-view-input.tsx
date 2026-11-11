import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {recordedContext,recordedReads,recordedResponse,recordedCitationIds,traceLabel,type TraceEvent,type InitialContext} from './agent-view-trace';
import { Loading } from '../../Loading';

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
 return <section className="agent-startup"><p className="agent-access-note">{moteText('先提供目录和能力，原文按需读取。')}</p><div className="agent-startup-box"><h2>{moteText('首次上下文预览')}</h2><p>{moteText('个人上下文目录、检索工具和当前可访问范围。')}</p><details className="agent-startup-structure"><summary>{moteText('展开示例结构')}</summary>
  <form className="agent-preview-form" onSubmit={e=>{e.preventDefault();setSubmitted(question);setRefresh(v=>v+1);}}><label>{moteText('想问的问题')}<input maxLength={4000} value={question} onChange={e=>setQuestion(e.target.value)} placeholder={moteText('输入问题，看看启动时会带上哪些记忆线索')}/></label><button className="button" type="submit">{moteText('预览首次上下文')}</button></form>
  <div className="agent-startup-rules"><p>{moteText('默认包含：系统规则、只读工具说明、当前问题、时间与设备范围，以及最多 5 条记忆线索。')}</p><p>{moteText('已有对话会按预算带入历史或工作摘要；此处预览的是没有历史的新对话。')}</p><p>{moteText('完整目录、文件正文和原图需要按需读取，原图还受独立授权控制。')}</p></div>
  {state.loading&&<Loading/>}{state.error!==undefined&&<p role="alert">{errorMessage(state.error)} <button className="text-button" onClick={()=>setRefresh(v=>v+1)}>{moteText('重试')}</button></p>}
  {state.data&&<><ContextContents context={state.data.context}/><details><summary>{moteText('可用的只读工具')} · {state.data.tools.length}</summary><div className="agent-tool-list">{state.data.tools.map(tool=><code key={tool}>{tool}</code>)}</div><pre className="feature-json">{JSON.stringify(state.data.toolDefinitions,null,2)}</pre></details><details><summary>{moteText('系统规则与工具')}</summary><pre className="feature-json">{state.data.system}</pre></details><details><summary>{moteText('查看上下文结构')}</summary><pre className="feature-json">{JSON.stringify(state.data.context,null,2)}</pre></details></>}
 </details></div></section>;
}
type RecordedPage={items:TraceEvent[];nextSeq:number;oldestSeq:number;recording:{enabled:boolean}};
export function RecordedInput({api,runId,setRunId,onOpen=()=>{}}:{api:Api;runId:string;setRunId:(id:string)=>void;onOpen?:(ref:string)=>void}){
 const [selection,setSelection]=useState<{api:Api;id:string;firstSeq:number;afterSeq:number;read:number}>(),[tab,setTab]=useState('input');
 const runs=useResource<{items:{runId:string;at:string;type:string;firstSeq:number}[];recording:{enabled:boolean}}>(api,'/api/agent-view/runs');
 const current=selection?.api===api&&selection.id===runId?selection:undefined;
 const page=useResource<RecordedPage>(api,current?`/api/agent-view/events?afterSeq=${current.afterSeq}&runId=${encodeURIComponent(current.id)}`:null,undefined,current?.read);
 const choose=(id:string)=>{setSelection(undefined);setTab('input');setRunId(id);};
 const read=()=>{if(!runId.trim())return;const firstSeq=Math.max(0,(runs.data?.items.find(run=>run.runId===runId)?.firstSeq??1)-1);setSelection({api,id:runId,firstSeq,afterSeq:firstSeq,read:(current?.read??0)+1});setTab('input');};
 const items=current&&page.data&&!page.error?page.data.items:[],visible=items.filter(item=>tab==='input'?['context.assembled','instructions.assembled'].includes(item.trace?.type??''):tab==='tools'?item.trace?.type==='tool.completed':item.trace?.type==='model.completed');
 const citations=recordedCitationIds(items);
 return <section className="agent-recorded"><h2>{moteText('实际输入与工具读取')}</h2>
  <div className="agent-run-selection"><label>{moteText('已记录的运行')}<select value={runs.data?.items.some(run=>run.runId===runId)?runId:''} onChange={e=>choose(e.target.value)}><option value="">{moteText('运行编号')}</option>{runs.data?.items.map(run=><option key={run.runId} value={run.runId}>{run.at} · {run.runId}</option>)}</select></label><button className="button" disabled={!runId.trim()||page.loading} onClick={read}>{moteText('读取运行记录')}</button><details className="agent-run-manual"><summary>{moteText('运行编号')}</summary><label>{moteText('运行编号')}<input value={runId} onChange={e=>choose(e.target.value)}/></label></details></div>
  {runs.error!==undefined&&<p role="alert">{errorMessage(runs.error)} <button onClick={runs.refresh}>{moteText('重试')}</button></p>}
  {!current&&<p role="status">{moteText('尚未读取这次运行')}</p>}
  {current&&page.loading&&<Loading label={moteText('正在读取记录')}/>}
  {current&&page.error!==undefined&&<p role="alert">{errorMessage(page.error)} <button onClick={page.refresh}>{moteText('重试')}</button></p>}
  {current&&page.data&&!page.loading&&!page.error&&<>
   <p className="agent-recording-status">{page.data.recording.enabled?moteText('输入追踪已开启'):moteText('输入追踪未开启')} · {moteText('仅显示已保留的事件，不能据此认定完整读取范围。')}</p>
   {current.afterSeq<page.data.oldestSeq-1&&<p>{moteText('更早的事件已不在保留范围内。')}</p>}
   <nav className="agent-recorded-tabs" aria-label={moteText('实际输入与工具读取')}>{[['input',moteText('模型输入')],['tools',moteText('工具读取')],['answer',moteText('输出')]].map(([id,label])=><button key={id} aria-selected={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</nav>
   <div className="agent-recorded-content">{visible.map(item=>{const context=recordedContext(item),reads=recordedReads(item),response=recordedResponse(item);return <article key={item.seq} className="agent-recorded-event">
    {(item.truncated||item.trace?.truncated)&&<p>{moteText('记录已截断，不能还原完整输入。')}</p>}
    {context&&<><div className="agent-question-card"><span>{moteText('用户问题')}</span><p className="agent-body">{context.request}</p></div><details className="agent-delivered-context"><summary>{moteText('这次实际交付的上下文')}</summary><ContextContents context={context}/></details></>}
    {item.trace?.type==='instructions.assembled'&&<details><summary>{moteText('系统规则与工具')}</summary><pre className="feature-json">{JSON.stringify(item.trace.payload,null,2)}</pre></details>}
    {tab==='tools'&&<details open><summary>{item.trace?.tool??moteText('调用工具')} · {item.trace?.status==='failed'?moteText('读取失败'):moteText('工具调用已完成')}</summary>{reads.map((value,index)=><div key={index}>{value.offset!==undefined&&<p className="fine-print">{moteText('已展开 {0}–{1} / {2} 个字符',value.offset,value.offset+value.text.length,value.total??value.offset+value.text.length)}</p>}<div className="agent-body">{value.text}</div></div>)}<details><summary>{moteText('查看记录内容')}</summary><pre className="feature-json">{JSON.stringify(item.trace?.payload,null,2)}</pre></details></details>}
    {response!==undefined&&<div className="agent-body">{response}</div>}
   </article>;})}{!visible.length&&<p>{moteText('此页没有已保留的模型输入或工具事件。')}</p>}
   {tab==='answer'&&citations.length>0&&<nav className="agent-output-evidence">{citations.map((id,index)=><button className="text-button" key={id} onClick={()=>onOpen('capture:'+id)}>{moteText('打开这次回答的原始依据')} {index+1}</button>)}</nav>}</div>
   <details className="agent-event-details"><summary>{moteText('技术详情')}</summary><ol className="agent-trace-list">{items.map(item=><li key={item.seq}><div className="agent-trace-heading"><strong>{traceLabel(item.trace?.type??'')}</strong>{item.trace?.tool&&<code>{item.trace.tool}</code>}<time>{item.at}</time></div>{(item.truncated||item.trace?.truncated)&&<p>{moteText('记录已截断，不能还原完整输入。')}</p>}<pre className="feature-json">{JSON.stringify(item.trace?.payload,null,2)}</pre></li>)}</ol></details>
   <div className="processing-actions"><button className="text-button" onClick={()=>{runs.refresh();page.refresh();}}>{moteText('刷新')}</button>{current.afterSeq!==current.firstSeq&&<button className="text-button" onClick={()=>setSelection({...current,afterSeq:current.firstSeq})}>{moteText('返回第一页')}</button>}{page.data.nextSeq>current.afterSeq&&<button className="text-button" onClick={()=>setSelection({...current,afterSeq:page.data!.nextSeq})}>{moteText('下一页')}</button>}</div>
  </>}
 </section>;
}
