import {useState} from 'react';
import {featureRequirementsAvailable} from '@mote/shared';
import {useDiscoveryState} from './DiscoveryLink';
import {getLocale,moteText} from '@mote/shared/i18n';
import {ArrowRight,ArrowUpRight,ChevronRight,Database,Link2,MessageCircle,Sparkles} from 'lucide-react';
import {answerPreview} from './AnswerMarkdown';
import {dateTime,errorMessage,type Activity,type Answer,type Api,type Capture,type Device,type Range,type Status} from './api';
import {type Page} from './navigation';
import {FeatureHome} from './features/home';
import {useResource} from './useResource';
import {HomeMaterialRow,type RecentMaterial} from './HomeMaterialRow';
import {ownerQuestionListPath} from './owner-question-route';

type FirstDeviceData={state:'waiting'|'unverified'|'received_unavailable'|'ready';originalAvailable:boolean;checkedDevices:number;checkedRecords:number;windowLimited:boolean;candidate?:{id:string;deviceId:string;deviceName:string;source:string;capturedAt:string;receivedAt:string}};
type Catalog={items:RecentMaterial[];sources?:{id:string;label:string;count:number}[];sourcesTruncated?:boolean};
type Conversation={id:string;title:string;updatedAt:string;turnCount:number};

export function Overview({api,status,devices,insights,onPage,onOpen}: {
 api:Api;status:Status;devices:Device[];activity:Activity;recent:Capture[];insights:Answer[];
 onPage:(page:Page)=>void;onOpen:(id:string)=>void;range:Range;onMedia:()=>void;
}){
 const [query,setQuery]=useState('');
 const availability=useDiscoveryState(api);
 const hasPage=(id:string)=>availability.pages.some(page=>page.id===id);
 const supports=(path:string)=>!availability.inventoryError&&featureRequirementsAvailable(['http:GET:'+path],availability.inventory);
 const canConversations=hasPage('ask')&&supports('/api/conversations'),canQuestions=hasPage('ask')&&supports('/api/owner-questions');
 const canActions=hasPage('actions')&&supports('/api/actions'),canTodos=hasPage('actions')&&supports('/api/todos');
 const canReadMaterial=supports('/api/materials/:id/read');
 const canPreviewMaterial=supports('/api/materials/:id/members')&&supports('/api/files/:id')&&supports('/api/files/:id/content');
 const sources=useResource<{items:{id:string;name?:string;status?:{state:string}}[]}>(api,'/api/sources');
 const connections=useResource<{items:{scope:string;revokedAt?:string;expiresAt?:string}[]}>(api,'/api/connections');
 const catalog=useResource<Catalog>(api,'/api/library/catalog?limit=3');
 const conversations=useResource<{items:Conversation[]}>(api,canConversations?'/api/conversations?limit=3':null);
 const questions=useResource<{items:{id:string}[];nextCursor?:string|null}>(api,canQuestions?ownerQuestionListPath():null);
 const actions=useResource<{items:{status:string;resolution?:string;event?:{start?:string|null;end?:string|null}}[];nextCursor:number|null}>(api,canActions?'/api/actions?cursor=0':null);
 const todos=useResource<{items:{status:string}[];nextCursor:string|null}>(api,canTodos?'/api/todos?status=open':null);
 const firstData=useResource<FirstDeviceData>(api,'/api/devices/first-data',undefined,status.storage?.captures);
 const checked=!firstData.loading&&!firstData.error?firstData.data:undefined;
 const retained=!firstData.error?firstData.data:undefined;
 const sample=retained?.candidate;
 const sourceReady=Boolean(checked?.checkedDevices);
 const complete=checked?.state==='ready'&&checked.originalAvailable&&Boolean(sample);
 const discovery=insights.find(item=>item.citations.length>0);
 const sourceItems=sources.error===undefined?sources.data?.items:undefined;
 const issues=sourceItems?.filter(item=>['error','permission_required'].includes(item.status?.state??''))??[];
 const grants=connections.error===undefined?connections.data?.items.filter(item=>item.scope==='mcp-read'&&!item.revokedAt&&(!item.expiresAt||Date.parse(item.expiresAt)>Date.now())):undefined;
 const knownCatalog=catalog.error===undefined?catalog.data:undefined;
 // Facets are metadata-only and bounded. A partial facet page is never an exact total.
 const materialCount=knownCatalog?.sourcesTruncated===false&&knownCatalog.sources?.every(source=>Number.isSafeInteger(source.count)&&source.count>=0)?knownCatalog.sources.reduce((sum,source)=>sum+source.count,0):undefined;
 const recentMaterials=knownCatalog?.items.filter(item=>item.id&&item.ref&&item.title&&item.origin)??[];
 const pendingQuestions=questions.error===undefined?questions.data?.items:undefined;
 const knownActions=actions.error===undefined&&actions.data?.nextCursor===null?actions.data.items:undefined;
 const activeActions=knownActions?.filter(item=>!item.resolution&&['proposed','approved','executing','uncertain'].includes(item.status));
 const actionAttention=activeActions?.filter(item=>item.status==='uncertain'||item.status==='proposed'&&(!item.event?.start||!item.event?.end));
 const knownTodos=todos.error===undefined&&todos.data?.nextCursor===null?todos.data.items:undefined;
 const recentConversations=conversations.error===undefined?conversations.data?.items:undefined;
 const firstReceipt=<section className={"panel central-onboarding"+(complete?" compact":"")} aria-label={moteText('开始使用')} data-onboarding-state={firstData.error?'error':firstData.loading?'loading':checked?.state??'unverified'}>
   {!complete&&<div className="central-first-steps">
    {[{ready:sourceReady,label:moteText('连接设备'),page:'deviceConnections',icon:Link2},{ready:Boolean(sample),label:moteText('中央已接收'),page:'devices',icon:Database},{ready:false,label:moteText('查看原文'),page:'archive',icon:Database}].map((step,index)=><button key={step.page} aria-label={step.label} className={step.ready?'completed':''} onClick={()=>step.page==='archive'&&sample?onOpen('capture:'+sample.id):onPage(step.page)}><span className="step-number">{step.ready?'✓':index+1}</span><step.icon size={20}/><strong>{step.label}</strong><ArrowRight size={16}/></button>)}
   </div>}
   <div className="central-first-data">
    {sample&&<div className="central-first-original" key={sample.id}>
     <p><strong>{moteText('中央已接收')}</strong>{' · '}{sample.deviceName}{' · '}<time dateTime={sample.receivedAt}>{new Date(sample.receivedAt).toLocaleString()}</time></p>
     <p>{moteText(firstData.loading?'尚未验证':complete?'原件已保留':'原件不可用')}{retained?.originalAvailable&&<> · <button className="text-button" onClick={()=>onOpen('capture:'+sample.id)}>{moteText('查看原文')}<ArrowRight size={15}/></button></>}</p>
    </div>}
    {firstData.loading?<p role="status">{moteText('正在读取采集记录…')}</p>:firstData.error?<p className="error" role="alert">{errorMessage(firstData.error)}</p>:!sample&&<p>{moteText(checked?.state==='waiting'?'准备好接住第一份记录':'最近记录')}{checked?.state!=='waiting'&&<> · {moteText('尚未验证')}</>}</p>}
    <details className="central-first-actions" open={!complete}><summary>{moteText('更多')}</summary><div className="button-row"><button className="button subtle" onClick={()=>firstData.refresh()} disabled={firstData.loading}>{moteText('刷新')}</button><button className="text-button" onClick={()=>onPage('archive')}>{moteText('打开资料库')}</button></div></details>
   </div>
  </section>;
 return <div className="home-page central-overview">
  <div className="page-heading home-heading"><h1>{moteText('首页')}</h1><div className="home-heading-meta"><time>{new Date().toLocaleDateString(getLocale(),{month:'long',day:'numeric'})} · {new Date().toLocaleDateString(getLocale(),{weekday:'short'})}</time><button className="text-button" onClick={()=>onPage('activity')}>{moteText('后台活动')}<ArrowRight size={13}/></button></div></div>
  {!complete&&firstReceipt}
  <form className="home-find" role="search" aria-label={moteText('搜索资料或提问')} onSubmit={event=>{event.preventDefault();if(query.trim())window.location.hash='/search?query='+encodeURIComponent(query.trim());}}>
   <input aria-label={moteText('搜索资料或提问')} placeholder={moteText('想找什么，或问点什么…')} maxLength={500} value={query} onChange={event=>setQuery(event.target.value)}/><button type="submit" className="button primary">{moteText('搜索')}</button><button type="button" className="button ghost" disabled={!hasPage('ask')} onClick={()=>{window.location.hash='/ask'+(query.trim()?'?questionDraft='+encodeURIComponent(query.trim()):'');}}>{moteText('问一问')}<ArrowUpRight size={13}/></button>
  </form>
  <section className="home-summary" aria-label={moteText('运行状态')}>
   <button onClick={()=>onPage('archive')}><span>{moteText('已有资料')}</span><strong>{materialCount??'—'}<small>{moteText('份')}</small></strong></button>
   <button onClick={()=>onPage('sources')}><span>{moteText('来源与设备')}</span><strong>{sourceItems?sourceItems.length+devices.length:'—'}<small>{moteText('项')}</small></strong></button>
   <button onClick={()=>onPage('connections')}><span>{moteText('AI 接入')}</span><strong>{grants?.length??'—'}<small>{moteText('个有效授权')}</small></strong></button>
  </section>
  {[catalog,sources,connections].map((resource,index)=>resource.error!==undefined&&<p className="home-read-error" role="alert" key={index}>{errorMessage(resource.error)}<button className="text-button" onClick={resource.refresh}>{moteText('重新读取')}</button></p>)}
  {issues.map(issue=><button className="home-source-issue" key={issue.id} onClick={()=>onPage('sources')}><span><i/>{issue.name||moteText('来源')} · {moteText('需要处理')}</span><span>{moteText('查看')}<ArrowRight size={13}/></span></button>)}
  {(Boolean(pendingQuestions?.length)||questions.error!==undefined)&&<div className="home-owner-question"><button className="text-button" onClick={()=>onPage('ask')}>{moteText('需要你补充')}{pendingQuestions?.length?<> · {moteText('{0} 条',pendingQuestions.length+(questions.data?.nextCursor?'+':''))}</>:null}<ArrowRight size={13}/></button>{questions.error!==undefined&&<p role="alert">{errorMessage(questions.error)}</p>}</div>}
  {(canActions||canTodos)&&<button className="home-action-entry" onClick={()=>onPage('actions')}><span><strong>{moteText('待办与日程')}</strong><small>{activeActions?moteText('{0} 条日程',activeActions.length):moteText('日程')}{Boolean(actionAttention?.length)&&<> · {moteText('{0} 项需处理',actionAttention!.length)}</>} · {knownTodos?moteText('{0} 项待办',knownTodos.filter(item=>item.status==='open').length):moteText('待办')}</small></span><span>{moteText('查看')}<ArrowRight size={13}/></span></button>}
  {(actions.error!==undefined||todos.error!==undefined)&&<p className="home-read-error" role="alert">{errorMessage(actions.error??todos.error)}<button className="text-button" onClick={()=>{actions.refresh();todos.refresh();}}>{moteText('重新读取')}</button></p>}
  <section className="home-discovery"><div className="section-heading"><h2>{moteText('精选发现')}</h2><div className="home-section-actions"><a className="text-button" href="#/library/insights?insight=new">{moteText('生成回顾')}</a><button className="text-button" onClick={()=>onPage('insights')}>{moteText('发现历史')}<ArrowRight size={13}/></button></div></div>
   {discovery?<a className="home-insight" href={'#/library/insights?insight='+encodeURIComponent(discovery.runId)}><Sparkles size={22}/><span><small className="home-discovery-label">{moteText('AI 发现')}</small><strong>{discovery.artifact?.title||moteText('你最近的洞察')}</strong><span className="home-discovery-copy">{answerPreview(discovery,180)}</span><small>{moteText('{0} 份依据',discovery.citations.length)}{discovery.createdAt&&<> · <time dateTime={discovery.createdAt}>{dateTime(discovery.createdAt)}</time></>}</small></span><ChevronRight size={15}/></a>:<p className="home-empty">{moteText('暂无发现')}</p>}
  </section>
  <section className="home-recent"><div className="section-heading"><h2>{moteText('最近资料')}</h2><button className="text-button" onClick={()=>onPage('archive')}>{moteText('查看全部')}<ArrowRight size={13}/></button></div>
   <div className="home-material-list">{recentMaterials.map(item=><HomeMaterialRow key={item.ref} api={api} item={item} label={knownCatalog?.sources?.find(source=>source.id===item.origin.sourceId)?.label} deviceName={devices.find(device=>device.deviceId===item.origin.deviceId)?.deviceName} onOpen={onOpen} canRead={canReadMaterial} canPreview={canPreviewMaterial}/>)}</div>
   {catalog.loading&&!catalog.data?<p role="status" className="home-empty">{moteText('正在读取…')}</p>:!catalog.error&&!recentMaterials.length&&<button className="text-button home-empty" onClick={()=>onPage('imports')}>{moteText('导入资料')}<ArrowRight size={13}/></button>}
  </section>
  {canConversations&&<section className="home-conversations"><div className="section-heading"><h2>{moteText('最近对话')}</h2><button className="text-button" onClick={()=>onPage('ask')}>{moteText('查看全部')}<ArrowRight size={13}/></button></div>
   {recentConversations?.map(item=><a className="home-conversation-row" key={item.id} href={'#/ask?conversation='+encodeURIComponent(item.id)}><MessageCircle size={18}/><span><strong>{item.title}</strong><small>{moteText('{0} 轮对话',item.turnCount)} · <time dateTime={item.updatedAt}>{dateTime(item.updatedAt)}</time></small></span><ChevronRight size={14}/></a>)}
   {conversations.error!==undefined?<p className="home-read-error" role="alert">{errorMessage(conversations.error)}<button className="text-button" onClick={conversations.refresh}>{moteText('重新读取')}</button></p>:conversations.loading&&!conversations.data?<p role="status" className="home-empty">{moteText('正在读取…')}</p>:!recentConversations?.length&&<button className="text-button home-empty" onClick={()=>onPage('ask')}>{moteText('开启一段对话')}<ArrowRight size={13}/></button>}
  </section>}
  <details className="home-extensions"><summary>{moteText('更多上下文视图')}</summary>{complete&&firstReceipt}<FeatureHome api={api} onPage={onPage}/></details>
 </div>;
}
