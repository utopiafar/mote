import React from 'react';
import {featureRequirementsAvailable} from '@mote/shared';
import type {Api} from '../api';
import type {Page} from '../navigation';
import type {HomeEntry} from './types';
import type {HomeSnapshot} from '../plugins/home/controller';
type Props={api:Api;state:HomeSnapshot;onPage:(page:Page)=>void};
class HomeBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?null:this.props.children;}
}
function HomeContent({entry,props}:{entry:HomeEntry;props:Props}){
 const remote=entry.requires?.filter(dep=>typeof dep==='string'||dep.host==='server')??[];
 return !remote.length||featureRequirementsAvailable(remote,props.state.availability.inventory)?entry.render({api:props.api,onPage:props.onPage}):null;
}
/** The home page is a host slot. Installed plugins own its contents; the
 * home controller owns the registry subscription and inventory read. */
export function FeatureHome(props:Props){
 return <>{props.state.homeEntries.map(entry=><HomeBoundary key={entry.id}><HomeContent entry={entry} props={props}/></HomeBoundary>)}</>;
}
