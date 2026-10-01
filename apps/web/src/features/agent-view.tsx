import {ArrowRight,Eye} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {HomeEntry,PageEntry} from './types';
// Keep this small, read-only entry in the home bundle. An already-open home
// remains navigable when a deployment removes the previous hashed assets.
// Data is still requested only when the inspector or a selected tab mounts.
import {AgentInspector} from '../AgentInspector';
export const pages:PageEntry[]=[{id:'agentView',route:'agent',aliases:['system/agent'],label:moteText('Agent 视角'),featureId:'mote.agent-view',render:({api,onOpen})=><AgentInspector api={api} onOpen={onOpen}/>}];
export const homeEntries:HomeEntry[]=[{id:'agent-view',featureId:'mote.agent-view',order:0,render:({onPage})=><button className="home-agent-view" onClick={()=>onPage('agentView')}><span className="home-agent-icon"><Eye size={25}/></span><span><strong>{moteText('换个视角，看看 Agent 能看到什么')}</strong><small>{moteText('打开它的目录，查看首次上下文和实际读取。')}</small><span className="home-agent-layers">/context <span>memory</span><span>episodes</span><span>sources</span></span></span><ArrowRight size={20}/></button>}];
