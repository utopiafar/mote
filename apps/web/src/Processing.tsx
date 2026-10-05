import {FeaturePanels} from './features/runtime';
import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {OperationPage,OperationDetail,OperationState,OperationSummary} from '@mote/shared';
import {type Api,errorMessage} from './api';
import type {Page} from './navigation';
import {useResource} from './useResource';
import {operationFeed} from './operation-feed';
import {ListPagination,useCursorPages} from './ListPagination';
import {containDialogFocus} from './dialog-focus';
import {WorkflowProcessing} from './WorkflowProcessing';
const states:Record<OperationState,string>={waiting:'等待处理',running:'运行中',blocked:'受阻',failed:'失败',cancelled:'已取消',succeeded:'完成',stale:'来源变化待重验',skipped:'未安排'};
const kinds:Record<string,string>={file:'文件处理',capture:'截图处理',memory:'记忆整理',workflow:'上下文处理',import:'资料导入',query:'问答',insight:'洞察',embedding:'检索向量计算','material-index':'资料检索索引'};
const steps:Record<string,string>={'material.index':'资料检索索引','files.pipeline':'内容提取','files.summary':'文件摘要','file-step':'格式处理','perception.ocr':'文字识别','perception.semantic':'图片理解','memory.batch':'记忆批次','imports.prepare':'分析原件','imports.commit':'保存记录','query.run':'问答','insight.run':'洞察','lifecycle-window':'后台整理窗口','actions.extract':'日程分析','embedding.capture':'记录向量索引','embedding.file':'文件片段向量索引','embedding.query':'检索向量计算'};
const destinations:Record<string,Page>={file:'files',capture:'timeline',memory:'memories',workflow:'timeline',import:'imports',query:'ask',insight:'insights',embedding:'ask','material-index':'library'};
const reasons:Record<string,string>={awaiting_confirmation:'等待确认',interrupted:'运行已中断，请重试',timeout:'执行超时，请重试',model_unconfigured:'请配置模型服务',dependency_failed:'依赖步骤未完成，请先检查上游任务',processor_version_unavailable:'处理器版本不可用',daily_budget:'等待每日额度',budget:'等待每日额度',cancelled:'用户取消',lease_expired:'运行中断，等待恢复',summary_disabled:'未安排摘要',local_only:'仅在本地处理',awaiting_activation:'等待记忆任务启动',input_changed:'来源变化待重验',provider_not_configured:'请配置模型服务',unsupported_format:'不支持此文件格式'};
function Badge({state}:{state:OperationState}){return <span className={'badge '+(['failed','blocked','stale'].includes(state)?'amber':state==='succeeded'?'green':'muted')}>{moteText(states[state])}</span>;}
function Progress({operation:o}:{operation:OperationSummary}){return <><p>{moteText('已完成 {0} / {1} 步',o.counts.succeeded,o.total-o.notScheduled-(o.optionalIssues??0))}{o.notScheduled>0&&' · '+moteText('{0} 步未安排',o.notScheduled)}{(o.optionalIssues??0)>0&&' · '+moteText('{0} 个可选步骤未完成',o.optionalIssues!)}</p><progress aria-label={moteText('处理进度')} value={o.counts.succeeded+o.notScheduled+(o.optionalIssues??0)} max={Math.max(1,o.total)}/></>;}
function Detail({api,id,onClose,onNavigate,opener}:{api:Api;id:string;onClose:()=>void;onNavigate:(page:Page)=>void;opener:HTMLElement|null}){
 const paging=useCursorPages(),heading=useRef<HTMLHeadingElement>(null),panel=useRef<HTMLElement>(null),[retryBusy,setRetryBusy]=useState(false),[retryError,setRetryError]=useState('');
 const query=new URLSearchParams({limit:'10',...paging.cursor?{cursor:String(paging.cursor)}:{}});
 const {data,error,loading,refresh}=useResource<OperationDetail>(api,'/api/operations/'+encodeURIComponent(id)+'?'+query);
 useEffect(()=>panel.current?containDialogFocus(panel.current,opener,heading.current):undefined,[id]);
 const retryIndex=async()=>{setRetryBusy(true);setRetryError('');try{await api.request('/api/materials/'+encodeURIComponent(id.slice('material-index:'.length))+'/index/retry',{method:'POST'});refresh();}catch(error){setRetryError(errorMessage(error));}finally{setRetryBusy(false);}};
 return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose();}}}>
  <section ref={panel} className="modal processing-detail" role="dialog" aria-modal="true" aria-label={moteText('任务详情')}>
   <div className="section-heading"><h2 ref={heading} tabIndex={-1}>{moteText('任务详情')}</h2><button className="button" onClick={onClose}>{moteText('关闭')}</button></div>
   {error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)} <button className="button" onClick={refresh}>{moteText('重试')}</button></p>}{loading&&!data&&<p role="status">{moteText('正在读取…')}</p>}
   {retryError&&<p role="alert">{retryError}</p>}{data&&<>
    <p className="operation-id"><code>{id}</code></p><Badge state={data.operation.state}/><Progress operation={data.operation}/>
    {data.operation.kind==='material-index'&&data.operation.state==='failed'&&<button className="button" disabled={retryBusy} onClick={()=>void retryIndex()}>{moteText('仅重试检索索引')}</button>}
    <div className="processing-list">{data.steps.map(step=><article key={step.id} className="processing-row"><header><h3>{moteText(steps[step.kind]||(step.kind.startsWith('embedding.query.')?'检索向量计算':'上下文处理'))}</h3><Badge state={step.notScheduled?'skipped':step.state}/></header>{!step.current&&<p className="fine-print">{moteText('历史配置步骤，不计入当前进度')}</p>}<p>{moteText('尝试次数')} {step.attempts} · {moteText('依赖步骤')} {step.dependencies.length}</p>{step.reason&&<p>{moteText(reasons[step.reason]||'处理未完成，请在来源页面查看详情')} <code>{step.reason}</code></p>}{step.state==='waiting'&&step.availableAt>Date.now()&&<p>{moteText('下次可运行时间')} · {new Date(step.availableAt).toLocaleString()}</p>}<details><summary>{moteText('步骤详情')}</summary><p><code>{step.id}</code></p>{step.dependencies.map(dep=><p key={dep}><code>{dep}</code></p>)}</details></article>)}</div>
    <ListPagination label={moteText('步骤分页')} paging={paging} nextCursor={data.nextCursor} count={data.steps.length} loading={loading}/>
    <FeaturePanels api={api} onOpen={()=>{}} value={{kind:'mote.operation',schemaVersion:1,representation:'saved-record',ref:id,revision:String(data.operation.updatedAt),title:id,text:JSON.stringify(data,null,2)}}/>
    <div className="processing-actions"><button className="button" onClick={()=>onNavigate(data.operation.id.startsWith('workflow:actions:')?'actions':destinations[data.operation.kind]??'timeline')}>{moteText('打开来源与处理操作')}</button></div>
   </>}
  </section>
 </div>;
}
function OperationsCentre({api,onNavigate}:{api:Api;onNavigate:(page:Page)=>void}){
 const [state,setState]=useState<OperationState|''>(''),[kind,setKind]=useState(''),[pageSize,setPageSize]=useState(10),[selected,setSelected]=useState(''),[workflowsOpen,setWorkflowsOpen]=useState(false);
 const paging=useCursorPages(),opener=useRef<HTMLButtonElement|null>(null);
 const feed=useMemo(()=>operationFeed(api),[api]),feedError=useSyncExternalStore(feed.subscribe,feed.getSnapshot,feed.getSnapshot);
 const query=new URLSearchParams({limit:String(pageSize),...state?{state}:{},...kind?{kind}:{},...paging.cursor?{cursor:String(paging.cursor)}:{}});
 const {data,error,loading,refresh}=useResource<OperationPage>(api,'/api/operations?'+query);
 return <div className="processing-centre">
  <div className="page-heading settings-heading"><div><div className="eyebrow">MOTE / SYSTEM</div><h1>{moteText('处理任务')}</h1><p>{moteText('查看截图、文件、上下文与记忆整理的进度、依赖和等待原因。')}</p></div><button className="button subtle" disabled={loading} onClick={refresh}>{moteText('刷新')}</button></div>
  <section className="panel operations-panel">
   <div className="processing-filters">
    <label>{moteText('任务状态')}<select aria-label={moteText('任务状态')} value={state} onChange={e=>{setState(e.target.value as OperationState|'');paging.reset();}}><option value="">{moteText('全部')}</option>{Object.entries(states).map(([value,label])=><option key={value} value={value}>{moteText(label)}</option>)}</select></label>
    <label>{moteText('任务类型')}<select aria-label={moteText('任务类型')} value={kind} onChange={e=>{setKind(e.target.value);paging.reset();}}><option value="">{moteText('全部')}</option>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{moteText(label)}</option>)}</select></label>
    <button className="text-button" onClick={()=>onNavigate('settings')}>{moteText('模型与服务')}</button>
   </div>
   {feedError!==undefined&&<p className="notice" role="status">{moteText('进度连接暂时中断，正在自动重连。')}</p>}{error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}{loading&&!data&&<p role="status">{moteText('正在读取…')}</p>}
   <div className="operation-list" aria-busy={loading}>{data?.items.map(operation=><article key={operation.id} className="operation-row">
    <div className="operation-title"><h2>{moteText(kinds[operation.kind]||'上下文处理')}</h2><code title={operation.id}>{operation.id}</code></div>
    <Badge state={operation.state}/><div className="operation-progress"><Progress operation={operation}/></div>
    <time className="operation-time" dateTime={new Date(operation.updatedAt).toISOString()}>{new Date(operation.updatedAt).toLocaleString()}</time>
    <button className="button subtle" aria-label={moteText('查看任务 {0} 的详情',operation.id)} aria-haspopup="dialog" onClick={e=>{opener.current=e.currentTarget;setSelected(operation.id);}}>{moteText('查看详情')}</button>
   </article>)}</div>
   {data&&!data.items.length&&<div className="empty"><h2>{moteText('没有符合条件的任务')}</h2></div>}
   <ListPagination label={moteText('任务分页')} paging={paging} nextCursor={data?.nextCursor} count={data?.items.length??0} loading={loading} pageSize={pageSize} onPageSize={size=>{setPageSize(size);paging.reset();}}/>
  </section>
  {selected&&<Detail key={selected} api={api} id={selected} opener={opener.current} onNavigate={onNavigate} onClose={()=>setSelected('')}/>}
  <details className="panel processing-advanced" onToggle={e=>setWorkflowsOpen(e.currentTarget.open)}><summary>{moteText('上下文步骤操作')}</summary>{workflowsOpen&&<WorkflowProcessing api={api} embedded onNavigate={onNavigate}/>}</details>
  <div className="processing-actions">{(['files','imports','memories','ask','actions'] as const).map((page,i)=><button className="text-button" key={page} onClick={()=>onNavigate(page)}>{moteText(['文件与录音','导入','记忆','问一问','行动'][i])}</button>)}</div>
 </div>;
}
export function Processing({api,extensions=false,embedded=false,onNavigate}:{api:Api;extensions?:boolean;embedded?:boolean;onNavigate:(page:Page)=>void}){return extensions?<WorkflowProcessing api={api} extensions embedded={embedded} onNavigate={onNavigate}/>:<OperationsCentre api={api} onNavigate={onNavigate}/>;}
