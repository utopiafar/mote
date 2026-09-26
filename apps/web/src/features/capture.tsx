import { moteText } from '@mote/shared/i18n';

import { Timeline } from '../Archive';
import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'timeline',route:'library/segments',label:moteText('片段'),section:'library',order:3,featureId:'mote.capture',render:({api,devices,onOpen:setEvidenceId,timelineRevision}:PageProps)=>(
                        <Timeline
                          api={api}
                          devices={devices}
                          onOpen={setEvidenceId}
                          revision={timelineRevision}
                        />
                      )},
];
