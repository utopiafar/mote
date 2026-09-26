import { moteText } from '@mote/shared/i18n';
import { CodingUploads } from '../CodingUploads';
import { Materials } from '../Materials';

import { Archive } from '../Archive';
import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'materials',route:'library/materials',label:moteText('正式资料'),section:'library',order:1,featureId:'mote.materials',requires:['http:GET:/api/materials'],render:({api,onOpen})=><Materials api={api} onOpen={onOpen}/>},
{id:'coding',route:'library/coding',label:moteText('Coding Agent 上传'),section:'library',order:2,featureId:'mote.coding',requires:['http:GET:/api/coding/uploads'],render:({api,onOpen})=><CodingUploads api={api} onOpen={onOpen}/>},
{id:'archive',route:'library',label:moteText('全部资料'),section:'library',order:0,featureId:'mote.materials',render:({api,devices,activity,onOpen:setEvidenceId,range,archiveTab,setArchiveTab,timelineRevision,refresh}:PageProps)=><Archive onChanged={refresh} tab={archiveTab} setTab={setArchiveTab} api={api} devices={devices} range={range} activity={activity} revision={timelineRevision} onOpen={setEvidenceId}/>},
];
