import {featureRequirementsAvailable,type FeatureInventory} from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import React,{ useSyncExternalStore } from 'react';
import { AnswerMarkdown } from '../AnswerMarkdown';
import { useResource } from '../useResource';
import { builtinCollections } from './collections';
import { builtinPages } from './entries';
import { homeEntries } from './agent-view';
import {webFeatures} from './registry';
export {webFeatures} from './registry';
import {ErrorNotice,Spinner} from '../shell-components';
import {errorMessage} from '../api';
import { MemoryRecordPanel } from './memory-record';
import {sourceMaterialViews} from './source-material';
import type { PageProps,ViewProps } from './types';
export const featuresReady=(async()=>{
  for(const id of new Set([...builtinPages,...builtinCollections,...homeEntries].map(page=>page.featureId)))await webFeatures.install({id,version:'1',components:[]},[...builtinPages.filter(page=>page.featureId===id).map(entry=>({surface:'page' as const,entry})),...builtinCollections.filter(page=>page.featureId===id).map(entry=>({surface:'collection' as const,entry})),...homeEntries.filter(entry=>entry.featureId===id).map(entry=>({surface:'home' as const,entry}))]);
  await webFeatures.install({id:'mote.saved-record-views',version:'1',components:[]},[
    {surface:'panel',entry:{id:'memory.saved',kind:'mote.memory',schemaVersion:1,representation:'saved-record',render:({value})=><MemoryRecordPanel record={JSON.parse(value.text)}/>}},
    {surface:'panel',entry:{id:'operation.saved',kind:'mote.operation',schemaVersion:1,representation:'saved-record',render:({value})=><details><summary>{moteText('保存记录（只读）')}</summary><pre className="feature-json">{value.text}</pre></details>}},
  ]);
  await webFeatures.install({id:'mote.source-material-views',version:'1',components:[]},sourceMaterialViews.map(entry=>({surface:'renderer' as const,entry})));
})();
class ViewBoundary extends React.Component<{fallback:React.ReactNode;children:React.ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?this.props.fallback:this.props.children;}
}
function PageContent({entry,props}:{entry:import('./types').PageEntry;props:PageProps}){return entry.render(props);}
function ViewContent({entry,props}:{entry:import('./types').ViewEntry;props:ViewProps}){
  const remote=entry.requires?.filter(dep=>typeof dep==='string'||dep.host==='server')??[];
  const capabilities=useResource<FeatureInventory>(props.api,remote.length?'/api/features':null,5000);
  if(remote.length&&!featureRequirementsAvailable(remote,capabilities.data))return <>{props.fallback}</>;
  return entry.render(props);
}
export function FeaturePage({page,props}:{page:string;props:PageProps}){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const entry=webFeatures.page(page);
  const remote=entry?.requires?.filter(dep=>typeof dep==='string'||dep.host==='server')??[];
  const capabilities=useResource<FeatureInventory>(props.api,remote.length?'/api/features':null,5000);
  const unavailable=<p role="status">{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>;
  if(remote.length&&capabilities.error)return <ErrorNotice text={errorMessage(capabilities.error)} retry={capabilities.refresh}/>;
  if(remote.length&&!capabilities.data)return <Spinner/>;
  if(remote.length&&(!capabilities.data||capabilities.data.schemaVersion!==1||!featureRequirementsAvailable(remote,capabilities.data)))return unavailable;
  return <ViewBoundary key={page} fallback={unavailable}>{entry?<PageContent entry={entry} props={props}/>:unavailable}</ViewBoundary>;
}
export function FeatureView(props:ViewProps){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const fallback=props.fallback??<AnswerMarkdown answer={{answer:props.value.text,runId:props.value.ref,trace:[],citations:[]}} onOpen={props.onOpen}/>;
  const renderers=webFeatures.views('renderer',props.value).filter(entry=>!props.catalog?.detail||entry.id===props.catalog.detail);
  // Ambiguous providers never win by installation order. Keep the safe default.
  return <><ViewBoundary key={props.value.ref+props.value.revision} fallback={fallback}>{renderers.length===1?<ViewContent entry={renderers[0]} props={{...props,fallback}}/>:fallback}</ViewBoundary><FeaturePanels {...props}/></>;
}
export function FeaturePanels(props:ViewProps){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  return <>{webFeatures.views('panel',props.value).filter(entry=>!props.catalog?.panels||props.catalog.panels.includes(entry.id)).map(panel=><ViewBoundary key={panel.id+props.value.ref+props.value.revision} fallback={null}><ViewContent entry={panel} props={{...props,fallback:null}}/></ViewBoundary>)}</>;
}

export function CollectionContent({entry,props}:{entry:import('./types').CollectionEntry;props:import('./types').CollectionProps}){
  const remote=entry.requires?.filter(dep=>typeof dep==='string'||dep.host==='server')??[];
  const capabilities=useResource<FeatureInventory>(props.api,remote.length?'/api/features':null,5000);
  if(remote.length&&capabilities.error!==undefined)return <ErrorNotice text={errorMessage(capabilities.error)} retry={capabilities.refresh}/>;
  if(remote.length&&!capabilities.data)return <Spinner/>;
  if(remote.length&&!featureRequirementsAvailable(remote,capabilities.data))return <p role="status">{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>;
  return entry.render(props);
}
export function FeatureCollections({selected,onSelect,props}:{selected:string;onSelect:(id:string)=>void;props:import('./types').CollectionProps}){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const entries=webFeatures.collections(),entry=entries.find(e=>e.id===selected);
  return <><nav className="segmented-nav" aria-label={moteText('资料库分类')}>{entries.map(e=><button key={e.id} aria-current={e.id===selected?'page':undefined} onClick={()=>onSelect(e.id)}>{e.label}</button>)}</nav><ViewBoundary key={selected} fallback={<p>{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>}>{entry&&<CollectionContent entry={entry} props={props}/>}</ViewBoundary></>;
}

/** Card and command contributions use the same exact schema and dependency checks as details. */
export function FeatureCard(props:ViewProps){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const matches=webFeatures.views('card',props.value).filter(entry=>!props.catalog?.card||entry.id===props.catalog.card);
  return <ViewBoundary key={props.value.ref+props.value.revision} fallback={props.fallback}>{matches.length===1?<ViewContent entry={matches[0]} props={props}/>:props.fallback}</ViewBoundary>;
}
export function FeatureActions({position,...props}:ViewProps&{position:'card'|'detail'}){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  return <>{webFeatures.views('action',props.value).filter(entry=>'position' in entry&&entry.position===position&&(!props.catalog?.actions||props.catalog.actions.includes(entry.id))).map(entry=><ViewBoundary key={entry.id+props.value.ref+props.value.revision} fallback={null}><ViewContent entry={entry} props={{...props,fallback:null}}/></ViewBoundary>)}</>;
}
