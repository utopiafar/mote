import {moteText} from '@mote/shared/i18n';
import {ArrowRight,Eye} from 'lucide-react';
import {useEffect,useMemo} from 'react';
import type {Api} from '../../api';
import type {HomeEntry,PageEntry,PageProps} from '../../features/types';
import type {BuiltinWebPlugin} from '../types';
import {AgentInspector} from './AgentInspector';
import {AgentAccessContext} from './context';
import {AgentAccessController,createAgentAccessController} from './controller';

export {AgentInspector} from './AgentInspector';
export {AgentAccessController,createAgentAccessController} from './controller';
export type {AgentAccessControllerOptions,AgentAccessScope,AgentAccessSnapshot,AgentAccessState,AgentAccessTab} from './controller';
export {AgentAccessContext,type AgentAccessPluginContextValue} from './context';
export {useAgentAccess} from './hooks';
export {StartupPreview,RecordedInput} from './agent-view-input';
export {recordedCitationIds,recordedContext,recordedReads,recordedResponse,traceLabel} from './agent-view-trace';
export type {InitialContext,RecordedRead,TraceEvent} from './agent-view-trace';
export {ClientLoginApproval,type ClientLoginOutcome} from './ClientLoginApproval';
export {ProviderAuthorization} from './ProviderAuthorization';
export {RequestedDetails} from './RequestedDetails';

export interface AgentAccessPluginOptions {
  readonly api:Api;
  /** Test/consumer seam; defaults create the plugin-owned route controller. */
  readonly controller?:AgentAccessController;
}

/** The Agent access package owns the outward catalog, first-context preview,
 * retained-run reader and client login panel. Activate starts the route
 * controller; dispose releases the same instance. */
export function createAgentAccessPlugin(options:AgentAccessPluginOptions){
  const controller=options.controller??createAgentAccessController();
  const context={controller};
  let active=false;
  return {
    id:'mote.agent-view' as const,
    get controller():AgentAccessController{return controller;},
    get context():{controller:AgentAccessController}{return context;},
    activate():AgentAccessController{
      if(active)return controller;
      active=true;
      controller.start();
      return controller;
    },
    deactivate():void{
      if(!active)return;
      active=false;
      controller.stop();
    },
    dispose():void{
      active=false;
      controller.dispose();
    },
  };
}

export type AgentAccessPlugin=ReturnType<typeof createAgentAccessPlugin>;

/** The page boundary activates the factory-owned controller; the inspector
 * renders its snapshot. The inspector also exposes the current snapshot when
 * directly rendered without a plugin context. */
export function AgentAccessPage(props:PageProps){
  const plugin=useMemo(()=>createAgentAccessPlugin({api:props.api}),[props.api]);
  useEffect(()=>{
    plugin.activate();
    return()=>plugin.deactivate();
  },[plugin]);
  return <AgentAccessContext.Provider value={plugin.context}><AgentInspector api={props.api} onOpen={props.onOpen} devices={props.devices}/></AgentAccessContext.Provider>;
}

export const pages:PageEntry[]=[{id:'agentView',route:'agent',label:moteText('Agent 视角'),featureId:'mote.agent-view',render:(props:PageProps)=><AgentAccessPage {...props}/>}];

// Keep this small, read-only entry in the home bundle. An already-open home
// remains navigable when a deployment removes the previous hashed assets.
export const homeEntries:HomeEntry[]=[{id:'agent-view',featureId:'mote.agent-view',order:0,render:({onPage})=><button className="home-agent-view" onClick={()=>onPage('agentView')}><span className="home-agent-icon"><Eye size={25}/></span><span><strong>{moteText('换个视角，看看 Agent 能看到什么')}</strong><small>{moteText('打开它的目录，查看首次上下文和实际读取。')}</small><span className="home-agent-layers">/context <span>memory</span><span>episodes</span><span>sources</span></span></span><ArrowRight size={20}/></button>}];

export const agentAccess:BuiltinWebPlugin={id:'mote.agent-view',pages,home:homeEntries};
