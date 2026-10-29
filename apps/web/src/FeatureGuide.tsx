import {moteText} from '@mote/shared/i18n';
import {useContext,useLayoutEffect,useState} from 'react';
import type {Api} from './api';
import {DiscoveryLink,DiscoveryProvider,useDiscoveryState} from './DiscoveryLink';
import {guideSections,type GuideGroup,type GuideUnit} from './feature-guide-catalog';
import {guideVisit,leaveGuide} from './feature-guide-state';
import {QuickNoteContext} from './quick-note-context';
import {validatedReturnTarget} from './route-query';
import {webFeatures} from './features/registry';

const groups=guideSections.flatMap(section=>section.groups);
export function matchingGuideGroups(query:string):GuideGroup[]{
 const terms=query.trim().toLocaleLowerCase();
 if(!terms)return groups;
 return groups.map(group=>({...group,units:group.units.filter(unit=>(moteText(unit.title)+' '+moteText(group.title)).toLocaleLowerCase().includes(terms))})).filter(group=>group.units.length>0);
}
/** All entries retain the runtime destination guard; opening the directory never runs work. */
export function FeatureGuide({api,onPage}:{api:Api;onPage:(page:string)=>void}){
 const availability=useDiscoveryState(api),visit=guideVisit(api),openNote=useContext(QuickNoteContext);
 const [query,setQuery]=useState(visit.query),[expanded,setExpanded]=useState(()=>new Set(visit.expanded));
 const matched=matchingGuideGroups(query),searching=Boolean(query.trim());
 useLayoutEffect(()=>{
  setQuery(visit.query);setExpanded(new Set(visit.expanded));
  if(visit.scroll>0)window.scrollTo({top:visit.scroll});
  const remember=()=>{visit.scroll=window.scrollY;};
  window.addEventListener('scroll',remember,{passive:true});
  return()=>window.removeEventListener('scroll',remember);
 },[visit]);
 function navigate(unit:GuideUnit,href:string){
  if(unit.target.pageId==='notes'&&openNote){openNote();return;}
  leaveGuide(api);window.location.hash=href;
 }
 function back(){
  const target=validatedReturnTarget(visit.origin,webFeatures.pages(),webFeatures.collections());
  visit.returnAvailable=false;
  if(target&&target.split('?')[0]!=='#/guide')window.location.hash=target;else onPage('overview');
 }
 return <DiscoveryProvider state={availability}><div className="feature-guide">
  <div className="guide-heading"><h1>{moteText('全部功能')}</h1><button className="text-button" onClick={back}><span aria-hidden="true">← </span>{moteText('返回')}</button></div>
  <label className="guide-search"><span aria-hidden="true">⌕</span><input aria-label={moteText('查找功能')} placeholder={moteText('想做什么？例如：修改记忆、日历、备份')} value={query} onChange={event=>{setQuery(event.target.value);visit.query=event.target.value;}}/></label>
  <div className="guide-groups">{matched.map(group=><details key={group.id} className="guide-group" data-guide-group={group.id} open={searching||expanded.has(group.id)} onToggle={event=>{
   if(searching)return;
   const open=event.currentTarget.open;
   setExpanded(previous=>{if(previous.has(group.id)===open)return previous;const next=new Set(previous);if(open)next.add(group.id);else next.delete(group.id);visit.expanded=[...next];return next;});
  }}>
   <summary>{moteText(group.title)}</summary>
   <div className="guide-unit-list">{group.units.map(unit=><div className="guide-unit" data-capability-id={unit.id} key={unit.id}><DiscoveryLink target={unit.target} className="guide-unit-link" onNavigate={href=>navigate(unit,href)}><span>{moteText(unit.title)}</span><span className="guide-chevron" aria-hidden="true">›</span></DiscoveryLink></div>)}</div>
  </details>)}</div>
  {!matched.length&&<p className="guide-empty" role="status">{moteText('没有找到匹配的功能。试试更简短的关键词。')}</p>}
 </div></DiscoveryProvider>;
}
