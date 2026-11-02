import {featureRequirementsAvailable,type FeatureInventory} from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import React,{ useSyncExternalStore } from 'react';
import { AnswerMarkdown } from '../AnswerMarkdown';
import { useResource } from '../useResource';
import {webFeatures} from './registry';
import {ErrorNotice,Spinner} from '../shell-components';
import {errorMessage} from '../api';
import type { PageProps,ViewProps } from './types';
class ViewBoundary extends React.Component<{fallback:React.ReactNode;children:React.ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?this.props.fallback:this.props.children;}
}
function PageContent({entry,props}:{entry:import('./types').PageEntry;props:PageProps}){return entry.render(props);}
function ViewContent({entry,props}:{entry:import('./types').ViewEntry;props:ViewProps}){
  const remote=entry.requires?.filter(dep=>typeof dep==='string'||dep.host==='server')??[];
  const capabilities=useResource<FeatureInventory>(props.api,remote.length?'/api/features':null,5000);
  if(remote.length&&capabilities.error!==undefined)return <ErrorNotice text={errorMessage(capabilities.error)} retry={capabilities.refresh}/>;
  if(remote.length&&!capabilities.data)return <Spinner/>;
  if(remote.length&&(!Array.isArray(capabilities.data?.capabilities)||!featureRequirementsAvailable(remote,capabilities.data)))return <>{props.fallback}</>;
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
export function FeaturePanels({unavailable,...props}:ViewProps&{unavailable?:React.ReactNode}){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const panels=webFeatures.views('panel',props.value).filter(entry=>!props.catalog?.panels||props.catalog.panels.includes(entry.id)),fallback=unavailable??null;
  return <>{panels.length?panels.map(panel=><ViewBoundary key={panel.id+props.value.ref+props.value.revision} fallback={fallback}><ViewContent entry={panel} props={{...props,fallback}}/></ViewBoundary>):fallback}</>;
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

// --- U07: plugins-domain declarative consumption --------------------------------
// The real plugins DOMAIN (PluginCenterView/PluginInstanceView: identity,
// revision, desired/observed, allowedActions) drives declared declarative
// surfaces. Commands are the same precise revision-carried API paths the
// inline buttons issued — nothing is relabeled or guessed.
import type { PluginInstanceView } from '@mote/shared';
import type { UiContributionDescriptor } from '@mote/shared/plugin-ui';
import { parseDeclarativeView, DeclarativeViewSession, DeclarativeView } from '../plugin-host/declarative-view';
import { createElement, useMemo } from 'react';

/** Command actions whose semantics are precise DOMAIN commands (revision
 * carried). 'configure' opens a dialog and is not an API command here. */
export const instanceCommandActions = ['check', 'enable', 'disable'] as const;
export type InstanceCommandAction = typeof instanceCommandActions[number];

/** Descriptor for one instance's action surface: only actions the DOMAIN
 * actually allowed are declared — nothing else can be invoked. */
export function pluginInstanceDescriptor(instance: PluginInstanceView): UiContributionDescriptor {
  const commands = instanceCommandActions.filter(a => instance.allowedActions.includes(a)).map(id => ({ id, apiVersion: '1' }));
  return { id: `instance:${instance.id}`, kind: 'declarative-view', apiVersion: '1', platforms: ['web'], presentation: { labelKey: 'instance', i18nNamespace: 'mote' }, commands };
}

/** Spec + data for the instance action surface driven by the real DOMAIN
 * fields; undefined allowedActions fail closed. */
export function pluginInstanceSpec(instance: PluginInstanceView) {
  return parseDeclarativeView({ components: [
    { type: 'detail', fields: [
      { key: 'scope', labelKey: 'scope' },
      { key: 'observed', labelKey: 'state', format: 'badge' },
    ] },
    ...(instanceCommandActions.filter(a => instance.allowedActions.includes(a)).map(a => ({ type: 'action' as const, command: a, labelKey: a }))),
  ] }, pluginInstanceDescriptor(instance));
}

/** The real invoker: each declared action is the same URL+revision the
 * inline control issued — /api/plugin-instances/{id}/{action} @ revision. */
export function pluginInstanceInvoker(instance: PluginInstanceView, invoke: (path: string, revision: number) => Promise<unknown> | void) {
  return (command: { id: string }) => invoke(`/api/plugin-instances/${encodeURIComponent(instance.id)}/${command.id}`, instance.revision);
}

/** Delegated instance action surface for PluginCenter: same DOMAIN fields
 * and the same precise commands, rendered through the schema-bound runtime. */
export function PluginInstanceSurface({ instance, busy, command, labels, stateLabel }: {
  instance: PluginInstanceView;
  busy: boolean;
  command: (path: string, revision: number) => void;
  labels: Record<string, string>;
  /** Existing localized state presentation (packageStateLabel); the raw
   * observed value never reaches the UI. */
  stateLabel: (observed: string) => string;
}) {
  const session = useMemo(() => new DeclarativeViewSession(
    pluginInstanceDescriptor(instance),
    pluginInstanceSpec(instance),
    async cmd => pluginInstanceInvoker(instance, command)(cmd),
  ), [instance, command]);
  const data = { scope: instance.scope, observed: stateLabel(instance.observed) };
  if (busy) return null;
  return createElement(DeclarativeView, { session, data, translate: k => labels[k] ?? k });
}
