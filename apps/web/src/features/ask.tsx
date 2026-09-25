import { moteText } from '@mote/shared/i18n';
import { AgentInspector } from '../AgentInspector';

import { Ask } from '../Ask';
import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'agentView',route:'system/agent',label:moteText('模型可见目录'),section:'system',order:1,featureId:'mote.agent-view',requires:['http:GET:/api/agent-view/catalog'],render:({api,onOpen})=><AgentInspector api={api} onOpen={onOpen}/>},
{id:'ask',route:'ask',label:moteText('问一问'),featureId:'mote.ask',render:({api,status,devices,insights,onPage,onOpen:setEvidenceId}:PageProps)=>status?(
                        <Ask
                          api={api}
                          devices={devices}
                          status={status}
                          onOpen={setEvidenceId}
                          onInsights={()=>onPage("insights")}
                          onSettings={()=>onPage("settings")}
                        />
                      ):null},
];
