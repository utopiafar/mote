import {createContext,useContext,useSyncExternalStore,type MouseEvent,type ReactNode} from 'react';
import {ArrowRight} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {FeatureInventory} from '@mote/shared';
import {type Api} from './api';
import {useResource} from './useResource';
import {webFeatures} from './features/registry';
import {resolveDiscoveryTarget,type DiscoveryState,type DiscoveryTarget} from './discovery-availability';

const DiscoveryContext=createContext<DiscoveryState|undefined>(undefined);
export function useDiscoveryState(api:Api):DiscoveryState{
 useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
 const inventory=useResource<FeatureInventory>(api,'/api/features',5000);
 return {pages:webFeatures.pages(),collections:webFeatures.collections(),inventory:inventory.data??undefined,inventoryError:inventory.error,inventoryLoading:inventory.loading};
}
export function DiscoveryProvider({state,children}:{state:DiscoveryState;children:ReactNode}){return <DiscoveryContext.Provider value={state}>{children}</DiscoveryContext.Provider>;}
export function discoveryAvailabilityText(state:'unavailable'|'checking'|'unknown'){
 return state==='checking'?moteText('正在确认当前支持情况…'):state==='unknown'?moteText('当前支持情况暂无法确认'):moteText('当前服务未提供此入口');
}
export function DiscoveryLink({target,children,className,arrow=false,disabledAs='span',onNavigate}:{target:DiscoveryTarget;children:ReactNode;className?:string;arrow?:boolean;disabledAs?:'span'|'div';onNavigate?:(href:string)=>void}){
 const state=useContext(DiscoveryContext);
 if(!state)throw new Error('DiscoveryLink requires a DiscoveryProvider');
 const availability=resolveDiscoveryTarget(target,state);
 const Disabled=disabledAs;
 if(availability.state!=='available')return <Disabled className={className?className+' discovery-link-unavailable':'discovery-link-unavailable'} aria-disabled="true">{children}<small className="discovery-availability">{discoveryAvailabilityText(availability.state)}</small></Disabled>;
 function navigate(event:MouseEvent<HTMLAnchorElement>){
  if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const live=resolveDiscoveryTarget(target,{...state!,pages:webFeatures.pages(),collections:webFeatures.collections()});
  if(live.state!=='available'){event.preventDefault();return;}
  event.preventDefault();if(onNavigate)onNavigate(live.href!);else window.location.hash=live.href!;
 }
 return <a href={availability.href} className={className} onClick={navigate}>{children}{arrow&&<ArrowRight size={15} aria-hidden="true"/>}</a>;
}
