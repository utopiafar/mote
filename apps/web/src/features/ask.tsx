import { moteText } from '@mote/shared/i18n';

import { Ask } from '../Ask';
import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
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
