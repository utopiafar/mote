import React,{useSyncExternalStore} from 'react';
import type {Api} from '../api';
import {webFeatures} from './registry';
import type {HomeEntry} from './types';
type Props={api:Api;onPage:(page:string)=>void};
class HomeBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?null:this.props.children;}
}
function HomeContent({entry,props}:{entry:HomeEntry;props:Props}){return entry.render(props);}
/** The home page is a host slot. Installed Cordis features own its contents. */
export function FeatureHome(props:Props){
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  return <>{webFeatures.homes().map(entry=><HomeBoundary key={entry.id}><HomeContent entry={entry} props={props}/></HomeBoundary>)}</>;
}
