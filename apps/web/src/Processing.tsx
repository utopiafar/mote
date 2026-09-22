import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {OperationPage,OperationDetail,OperationState,OperationSummary} from '@mote/shared';
import {type Api,errorMessage} from './api';
import type {Page} from './navigation';
import {useResource} from './useResource';
import {operationFeed} from './operation-feed';
import {WorkflowProcessing} from './WorkflowProcessing';
const states:Record<OperationState,string>={waiting:'等待处理',running:'运行中',blocked:'受阻',failed:'失败',cancelled:'已取消',succeeded:'完成',stale:'来源变化待重验',skipped:'未安排'};
const kinds:Record<string,string>={file:'文件处理',capture:'截图处理',memory:'记忆整理',workflow:'上下文处理'};
const steps:Record<string,string>={'files.pipeline':'内容提取','files.summary':'文件摘要','file-step':'格式处理','perception.ocr':'文字识别','perception.semantic':'图片理解','memory.batch':'记忆批次'};
const destinations:Record<string,Page>={file:'files',capture:'timeline',memory:'memories',workflow:'timeline'};
const reasons:Record<string,string>={dependency_failed:'依赖步骤未完成，请先检查上游任务',processor_version_unavailable:'处理器版本不可用',daily_budget:'等待每日额度',budget:'等待每日额度',cancelled:'用户取消',lease_expired:'运行中断，等待恢复',summary_disabled:'未安排摘要',local_only:'仅在本地处理',awaiting_activation:'等待记忆任务启动',input_changed:'来源变化待重验',provider_not_configured:'请配置模型服务',unsupported_format:'不支持此文件格式'};
function Badge({state}:{state:OperationState}){return <span className={'badge '+(['failed','blocked','stale'].includes(state)?'amber':state==='succeeded'?'green':'muted')}>{moteText(states[state])}</span>;}
function Progress({operation:o}:{operation:OperationSummary}){return <><p>{moteText('已完成 {0} / {1} 步',o.counts.succeeded,o.total-o.notScheduled)}{o.notScheduled>0&&' · '+moteText('{0} 步未安排',o.notScheduled)}</p><progress aria-label={moteText('处理进度')} value={o.counts.succeeded+o.notScheduled} max={Math.max(1,o.total)}/></>;}
function Detail({api,id,onClose,onNavigate}:{api:Api;id:string;onClose:()=>void;onNavigate:(page:Page)=>void}){
 const [cursor,setCursor]=useState<number>(),heading=useRef<HTMLHeadingElement>(null);
 const {data,error,loading,refresh}=useResource<OperationDetail>(api,'/api/operations/'+encodeURIComponent(id)+(cursor?'?cursor='+cursor:''));
 useEffect(()=>{heading.current?.focus();},[id]);
 return <section className="panel" aria-label={moteText('任务详情')}><div className="processing-actions"><h2 ref={heading} tabIndex={-1}>{moteText('任务详情')}</h2><button className="button" onClick={onClose}>{moteText('关闭')}</button></div>
  {error!==undefined&&<p role="alert">{errorMessage(error)} <button className="button" onClick={refresh}>{moteText('重试')}</button></p>}{loading&&!data&&<p role="status">{moteText('正在读取…')}</p>}
  {data&&<><p><code>{id}</code></p><Badge state={data.operation.state}/><Progress operation={data.operation}/><div className="processing-list">{data.steps.map(step=><article key={step.id} className="processing-row"><header><h3>{moteText(steps[step.kind]||'上下文处理')}</h3><Badge state={step.notScheduled?'skipped':step.state}/></header>{!step.current&&<p className="fine-print">{moteText('历史配置步骤，不计入当前进度')}</p>}<p>{moteText('尝试次数')} {step.attempts} · {moteText('依赖步骤')} {step.dependencies.length}</p>{step.reason&&<p>{moteText(reasons[step.reason]||'处理未完成，请在来源页面查看详情')} <code>{step.reason}</code></p>}{step.state==='waiting'&&step.availableAt>Date.now()&&<p>{moteText('下次可运行时间')} · {new Date(step.availableAt).toLocaleString()}</p>}<details><summary>{moteText('步骤详情')}</summary><p><code>{step.id}</code></p>{step.dependencies.map(dep=><p key={dep}><code>{dep}</code></p>)}</details></article>)}</div>
  <div className="processing-actions">{cursor&&<button className="button" onClick={()=>setCursor(undefined)}>{moteText('返回')}</button>}{data.nextCursor&&<button className="button" onClick={()=>setCursor(data.nextCursor!)}>{moteText('更多步骤')}</button>}<button className="button" onClick={()=>onNavigate(destinations[data.operation.kind]??'timeline')}>{moteText('打开来源与处理操作')}</button></div></>}
 </section>;
}
function OperationsCentre({api,onNavigate}:{api:Api;onNavigate:(page:Page)=>void}){
 const [state,setState]=useState<OperationState|''>(''),[kind,setKind]=useState(''),[cursor,setCursor]=useState<number>(),[selected,setSelected]=useState('');const opener=useRef<HTMLButtonElement|null>(null);
 const feed=useMemo(()=>operationFeed(api),[api]),feedError=useSyncExternalStore(feed.subscribe,feed.getSnapshot,feed.getSnapshot);
 const query=new URLSearchParams({...state?{state}:{},...kind?{kind}:{},...cursor?{cursor:String(cursor)}:{}});
 const {data,error,loading,refresh}=useResource<OperationPage>(api,'/api/operations'+(query.size?'?'+query:''));
 return <><div className="page-heading"><div className="eyebrow">MOTE / SYSTEM</div><h1>{moteText('处理任务')}</h1><p>{moteText('查看截图、文件、上下文与记忆整理的进度、依赖和等待原因。')}</p></div>
 <div className="processing-actions"><button className="button" onClick={refresh}>{moteText('刷新')}</button><button className="button" onClick={()=>onNavigate('settings')}>{moteText('模型与服务')}</button><label>{moteText('任务类型')} <select value={kind} onChange={e=>{setKind(e.target.value);setCursor(undefined);}}><option value="">{moteText('全部')}</option>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{moteText(label)}</option>)}</select></label></div>
 <nav className="section-tabs" aria-label={moteText('任务状态')}>{(['',...Object.keys(states)] as const).map(value=><button key={value} aria-current={state===value?'page':undefined} onClick={()=>{setState(value as OperationState|'');setCursor(undefined);}}>{moteText(value?states[value as OperationState]:'全部')}</button>)}</nav>
 {feedError!==undefined&&<p className="notice" role="status">{moteText('进度连接暂时中断，正在自动重连。')}</p>}{error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}{loading&&!data&&<p role="status">{moteText('正在读取…')}</p>}
 <div className="processing-list">{data?.items.map(operation=><article key={operation.id} className="processing-row"><header><h2>{moteText(kinds[operation.kind]||'上下文处理')}</h2><Badge state={operation.state}/></header><p><code>{operation.id}</code></p><Progress operation={operation}/><p className="fine-print">{moteText('更新时间')} · {new Date(operation.updatedAt).toLocaleString()}</p><button className="button" aria-expanded={selected===operation.id} onClick={e=>{opener.current=e.currentTarget;setSelected(operation.id);}}>{moteText('查看详情')}</button></article>)}</div>
 {data&&!data.items.length&&<div className="empty"><h2>{moteText('没有符合条件的任务')}</h2></div>}
 <div className="processing-actions">{cursor&&<button className="button" onClick={()=>setCursor(undefined)}>{moteText('返回')}</button>}{data?.nextCursor&&<button className="button" onClick={()=>setCursor(data.nextCursor!)}>{moteText('更多')}</button>}</div>
 {selected&&<Detail key={selected} api={api} id={selected} onNavigate={onNavigate} onClose={()=>{setSelected('');opener.current?.focus();}}/>}
 <details><summary>{moteText('上下文步骤操作')}</summary><WorkflowProcessing api={api} onNavigate={onNavigate}/></details>
 <div className="processing-actions">{(['files','imports','memories','ask','actions'] as const).map((page,i)=><button className="button" key={page} onClick={()=>onNavigate(page)}>{moteText(['文件与录音','导入','记忆','问一问','行动'][i])}</button>)}</div>
 </>;
}
export function Processing({api,extensions=false,onNavigate}:{api:Api;extensions?:boolean;onNavigate:(page:Page)=>void}){return extensions?<WorkflowProcessing api={api} extensions onNavigate={onNavigate}/>:<OperationsCentre api={api} onNavigate={onNavigate}/>;}
