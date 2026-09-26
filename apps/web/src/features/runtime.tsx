import type { FeatureInventory } from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import React,{ useSyncExternalStore } from 'react';
import { AnswerMarkdown } from '../AnswerMarkdown';
import { useResource } from '../useResource';
import { builtinCollections } from './collections';
import { builtinPages } from './entries';
import {webFeatures} from './registry';
export {webFeatures} from './registry';
import {ErrorNotice,Spinner} from '../shell-components';
import {errorMessage} from '../api';
import { MemoryRecordPanel } from './memory-record';
import type { PageProps,ViewProps } from './types';
export const featuresReady=(async()=>{
  for(const id of new Set([...builtinPages,...builtinCollections].map(page=>page.featureId)))await webFeatures.install({id,version:'1',components:[]},[...builtinPages.filter(page=>page.featureId===id).map(entry=>({surface:'page' as const,entry})),...builtinCollections.filter(page=>page.featureId===id).map(entry=>({surface:'collection' as const,entry}))]);
  await webFeatures.install({id:'mote.saved-record-views',version:'1',components:[]},[
    {surface:'panel',entry:{id:'memory.saved',kind:'mote.memory',schemaVersion:1,representation:'saved-record',render:({value})=><MemoryRecordPanel record={JSON.parse(value.text)}/>}},
    {surface:'panel',entry:{id:'operation.saved',kind:'mote.operation',schemaVersion:1,representation:'saved-record',render:({value})=><details><summary>{moteText('保存记录（只读）')}</summary><pre className="feature-json">{value.text}</pre></details>}},
  ]);
})();
class ViewBoundary extends React.Component<{fallback:React.ReactNode;children:React.ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?this.props.fallback:this.props.children;}
}
function PageContent({entry,props}:{entry:import('./types').PageEntry;props:PageProps}){return entry.render(props);}
function ViewContent({entry,props}:{entry:import('./types').ViewEntry;props:ViewProps}){return entry.render(props);}
export function FeaturePage({page,props}:{page:string;props:PageProps}){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const entry=webFeatures.page(page);
  const capabilities=useResource<FeatureInventory>(props.api,entry?.requires?.length?'/api/features':null);
  const unavailable=<p role="status">{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>;
  if(entry?.requires?.length&&capabilities.error)return <ErrorNotice text={errorMessage(capabilities.error)} retry={capabilities.refresh}/>;
  if(entry?.requires?.length&&!capabilities.data)return <Spinner/>;
  if(entry?.requires?.length&&(!capabilities.data||capabilities.data.schemaVersion!==1||entry.requires.some(id=>!capabilities.data?.capabilities.some(c=>c.id===id&&c.version==='1'&&c.state==='active'))))return unavailable;
  return <ViewBoundary key={page} fallback={unavailable}>{entry?<PageContent entry={entry} props={props}/>:unavailable}</ViewBoundary>;
}
export function FeatureView(props:ViewProps){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const fallback=<AnswerMarkdown answer={{answer:props.value.text,runId:props.value.ref,trace:[],citations:[]}} onOpen={props.onOpen}/>;
  const renderers=webFeatures.views('renderer',props.value),panels=webFeatures.views('panel',props.value);
  // Ambiguous providers never win by installation order. Keep the safe default.
  return <><ViewBoundary key={props.value.ref+props.value.revision} fallback={fallback}>{renderers.length===1?<ViewContent entry={renderers[0]} props={props}/>:fallback}</ViewBoundary><FeaturePanels {...props}/></>;
}
export function FeaturePanels(props:ViewProps){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  return <>{webFeatures.views('panel',props.value).map(panel=><ViewBoundary key={panel.id+props.value.ref+props.value.revision} fallback={null}><ViewContent entry={panel} props={props}/></ViewBoundary>)}</>;
}

function CollectionContent({entry,props}:{entry:import('./types').CollectionEntry;props:import('./types').CollectionProps}){return entry.render(props);}
export function FeatureCollections({selected,onSelect,props}:{selected:string;onSelect:(id:string)=>void;props:import('./types').CollectionProps}){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const entries=webFeatures.collections(),entry=entries.find(e=>e.id===selected);
  return <><nav className="segmented-nav" aria-label={moteText('资料库分类')}>{entries.map(e=><button key={e.id} aria-current={e.id===selected?'page':undefined} onClick={()=>onSelect(e.id)}>{e.label}</button>)}</nav><ViewBoundary key={selected} fallback={<p>{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>}>{entry&&<CollectionContent entry={entry} props={props}/>}</ViewBoundary></>;
}
