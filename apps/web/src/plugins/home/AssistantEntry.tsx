import {useMemo} from 'react';
import {ArrowRight,MessageCircle} from 'lucide-react';
import {featureRequirementsAvailable} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {DiscoveryLink} from '../../DiscoveryLink';
import {FirstDataFailure} from '../../FirstUseHome';
import {Loading} from '../../Loading';
import type {Api} from '../../api';
import {useResource} from '../../useResource';
import {useForegroundResources} from '../../useForegroundResources';
import {resources} from '../../resource-cache';
import {assistantDiscoveryTarget,assistantEntrypoints} from '../../assistant-entrypoints';
import type {AssistantTaskResultItem} from '../ask/AssistantTaskResults';
import {matterLabel} from '../assistant/common';
import {onboardingCapabilities,parseOnboarding,readStoredOnboardingRun} from '../sources/onboarding';
import {WorkStateBadge} from '../work/WorkProgress';
import type {HomeRead,HomeSnapshot} from './controller';
import {assistantScopeQuery,homeAssistantScope,type AssistantCard} from './assistant-cards';

function ReadState({read}:{read:HomeRead<unknown>}){
 return read.error!==undefined?<FirstDataFailure error={read.error}/>:read.loading||read.data===undefined?<Loading/>:null;
}

function LinkedTask({api,card}:{api:Api;card:AssistantCard}){
 const path='/api/assistant/tasks/'+encodeURIComponent(card.acceptedTaskId!)+'?'+assistantScopeQuery(homeAssistantScope);
 const read=useResource<AssistantTaskResultItem>(api,path,5000);
 useForegroundResources(api,[path]);
 const item=read.error===undefined?read.data:undefined;
 return <div data-home-task-id={card.acceptedTaskId}><a href={'#/today?'+new URLSearchParams({assistantTask:card.acceptedTaskId!})}><span>{card.title}</span>{item&&<WorkStateBadge state={item.task.state}/>}</a><ReadState read={read}/></div>;
}

/** Fixed Home navigation and exact receipt states. Opening this section only
 * reads existing work; starting acquaintance still requires material selection. */
export function AssistantEntry({state}:{state:HomeSnapshot}){
 const supports=(path:string)=>state.availability.inventoryError===undefined&&featureRequirementsAvailable(['http:GET:'+path],state.availability.inventory);
 const stored=readStoredOnboardingRun(),read=state.onboarding;
 const parsed=useMemo(()=>{if(read.data===undefined||read.error!==undefined)return;try{return parseOnboarding(read.data);}catch(error){return error instanceof Error?error:new Error(moteText('中央响应格式无效，请刷新后重试。'));}},[read.data,read.error]);
 const run=parsed instanceof Error?undefined:parsed;
 const canOnboarding=supports('/api/assistant/onboarding/:id');
 const canWork=supports('/api/work-activity')&&state.availability.pages.some(page=>page.id==='activity');
 const canMatters=supports('/api/assistant/matters')&&state.availability.pages.some(page=>page.id==='assistantMatters');
 const work=canWork&&state.work.error===undefined?state.work.data:undefined;
 const canTasks=supports('/api/assistant/tasks/:id')&&supports('/api/assistant-cards');
 const cardTasks=canTasks&&state.cards.error===undefined?state.cards.data?.items.filter((card,index,items)=>Boolean(card.acceptedTaskId)&&items.findIndex(item=>item.acceptedTaskId===card.acceptedTaskId)===index):undefined;
 const matters=canMatters&&state.matters.error===undefined?state.matters.data:undefined;
 const sources=state.sources.error===undefined?state.sources.data?.items:undefined;
 const revoked=sources?.filter(source=>source.status?.state==='permission_required').length;
 const auth=supports('/api/model-authorization')&&state.modelAuthorization.error===undefined?state.modelAuthorization.data?.authorization:undefined;
 const refreshing=[state.features,read,state.cards,state.work,state.matters,state.modelAuthorization,state.sources].some(value=>value.loading);
 const refresh=()=>{for(const value of [state.features,read,state.cards,state.work,state.matters,state.modelAuthorization,state.sources])value.refresh();for(const card of cardTasks??[])resources(state.api).get('/api/assistant/tasks/'+encodeURIComponent(card.acceptedTaskId!)+'?'+assistantScopeQuery(homeAssistantScope)).refresh();};
 return <section className="home-assistant-entry" aria-label={moteText('个人助理')}>
  <div className="section-heading"><h2>{moteText('个人助理')}</h2><button type="button" className="text-button" disabled={refreshing} onClick={refresh}>{moteText('刷新状态')}</button></div>
  <div className="home-assistant-conversation"><p>{moteText('在主对话交代工作，核对草稿后开始。')}</p><DiscoveryLink className="button primary" target={{pageId:'ask',href:'#/ask',requires:['http:GET:/api/conversations']}}><MessageCircle size={16}/>{moteText('主对话')}<ArrowRight size={15}/></DiscoveryLink></div>
  <div className="home-assistant-overview">
   <section className="home-assistant-destination" aria-label={moteText('初次认识')} data-onboarding-summary={read.error!==undefined||parsed instanceof Error?'error':run?.state??(stored?'loading':'unselected')}>
    <DiscoveryLink className="home-assistant-destination-link" disabledAs="div" target={{pageId:'sources',href:'#/connections',requires:[...onboardingCapabilities]}}><strong>{moteText('初次认识')}</strong><ArrowRight size={15}/></DiscoveryLink>
    {canOnboarding&&<>
     {!stored?<p>{moteText('此浏览器还没有可恢复的初次认识记录。')}</p>:<><ReadState read={read}/>{parsed instanceof Error&&<FirstDataFailure error={parsed}/>}</>}
     {run&&<div role="status"><strong>{moteText(run.state==='pending'?'处理中':run.state==='failed'?'处理失败':run.state==='cancelled'?'已取消':run.state==='empty'?'所选资料当前不可读取，请检查来源授权后重新选择。':'本次选择的资料已完成；其他资料未包含。')}</strong><p>{moteText('正文提取')} {run.coverage.extraction.completed} / {run.coverage.extraction.total}<br/>{moteText('语义理解')} {run.coverage.semantic.completed} / {run.coverage.semantic.total}</p></div>}
     <small>{moteText('连接成功只表示可以同步，不代表全库已经理解。')}</small>
    </>}
    {Boolean(revoked)&&<p className="notice">{moteText('需要重新授权')} · {revoked}</p>}
    {state.sources.error!==undefined&&<FirstDataFailure error={state.sources.error}/>}
   </section>
   <section className="home-assistant-destination" aria-label={moteText('当前任务')}>
    <strong className="home-assistant-destination-link">{moteText('当前任务')}</strong>
    {canTasks&&<><small>{moteText('本页建议关联的任务')}</small><ReadState read={state.cards}/>{cardTasks&&!cardTasks.length&&<p>{moteText('当前页没有建议关联的任务，可在主对话或事项中查看其他任务。')}</p>}<div className="home-assistant-status-list">{cardTasks?.map(card=><LinkedTask key={card.acceptedTaskId} api={state.api} card={card}/>)}</div></>}
    <DiscoveryLink className="text-button" target={{pageId:'activity',href:'#/activity',requires:['http:GET:/api/work-activity']}}>{moteText('后台活动')}<ArrowRight size={14}/></DiscoveryLink>
    {canWork&&<><small className="home-assistant-activity-note">{moteText('最近后台活动；更多任务和结果可进入查看。')}</small><ReadState read={state.work}/>{work&&!work.items.length&&<p>{moteText('暂无记录')}</p>}<div className="home-assistant-status-list">{work?.items.map(item=><a key={item.id} href={'#/activity?'+new URLSearchParams({work:item.id})}><span>{item.goal}</span><WorkStateBadge state={item.state}/></a>)}</div></>}
   </section>
   <section className="home-assistant-destination" aria-label={moteText('事项与规则')}>
    <DiscoveryLink className="home-assistant-destination-link" disabledAs="div" target={assistantDiscoveryTarget(assistantEntrypoints.find(entry=>entry.pageId==='assistantMatters')!)}><strong>{moteText('事项与规则')}</strong><ArrowRight size={15}/></DiscoveryLink>
    {canMatters&&<><small>{moteText('跟踪事项、承诺、期限和定期规则。')}</small><ReadState read={state.matters}/>{matters&&!matters.items.length&&<p>{moteText('暂无记录')}</p>}<div className="home-assistant-status-list">{matters?.items.map(item=><a key={item.id} href={'#/assistant/matters?'+new URLSearchParams({matter:item.id})}><span>{item.goal}</span><small>{matterLabel(item.state)}</small></a>)}</div></>}
   </section>
  </div>
  <nav className="home-assistant-tools" aria-label={moteText('助理功能')}>{assistantEntrypoints.filter(entry=>entry.pageId!=='assistantMatters').map(entry=><DiscoveryLink key={entry.pageId} className="text-button" target={assistantDiscoveryTarget(entry)}>{moteText(entry.title)}<ArrowRight size={14}/></DiscoveryLink>)}</nav>
  {auth&&<p className="fine-print" role="status">{moteText(auth.state==='on'?'后台模型已开启':'后台模型已关闭')} · {moteText('后台开关不改变采集设置，也不代表某项任务正在运行。')}</p>}
  {supports('/api/model-authorization')&&state.modelAuthorization.error!==undefined&&<FirstDataFailure error={state.modelAuthorization.error}/>}
 </section>;
}
