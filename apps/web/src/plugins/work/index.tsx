import { moteText } from '@mote/shared/i18n';
import React from 'react';
import type {WorkActivityPage} from '@mote/shared';
import {Activity as ActivityIcon,ChevronRight} from 'lucide-react';
import {useResource} from '../../useResource';
import {errorMessage,type Api} from '../../api';
import { LoadingText } from '../../Loading';
import {WorkStateBadge} from './WorkProgress';
import type { PageEntry, PageProps } from '../../features/types';
import type {Page} from '../../navigation';
import type { BuiltinWebPlugin } from '../types';

const Activity = React.lazy(() => import('./Activity').then(module => ({ default: module.Activity })));
const Actions = React.lazy(() => import('./Actions').then(module => ({ default: module.Actions })));

/** Compact background work shown inside diagnostics; the full activity page keeps
 * the detail view, evidence and technical records. */
export function ActivityOverview({api,onPage}:{api:Api;onPage:(page:Page)=>void}) {
  const attention=useResource<WorkActivityPage>(api,'/api/work-activity?state=attention&limit=3');
  const active=useResource<WorkActivityPage>(api,'/api/work-activity?state=active&limit=3');
  const error=attention.error??active.error,loading=(attention.loading&&!attention.data)||(active.loading&&!active.data);
  const items=[...(attention.data?.items??[]),...(active.data?.items??[])];
  return <section className="activity-overview" aria-label={moteText('后台活动')} aria-busy={loading}>
    {error!==undefined&&<p role="alert">{errorMessage(error)} <button type="button" className="text-button" onClick={()=>{attention.refresh();active.refresh();}}>{moteText('重试')}</button></p>}
    {loading&&!items.length?<LoadingText/>:items.length?items.map(work=><button type="button" key={work.id} className="processing-entry-row" onClick={()=>{window.location.hash='#/activity?'+new URLSearchParams({work:work.id});}}><span className="model-profile-symbol"><ActivityIcon size={18}/></span><span><strong>{work.goal}</strong></span><span className="processing-current"><WorkStateBadge state={work.state}/></span><ChevronRight size={15}/></button>):<p>{moteText('目前没有后台活动')}</p>}
    <button type="button" className="text-button" onClick={()=>onPage('activity')}>{moteText('全部活动')} →</button>
  </section>;
}

/** The work package owns background activity, its shared operation feed,
 * calendar and todo review, schedule information repair and the device
 * calendar capability authorization surface. */
export const pages: PageEntry[] = [
  {
    id: 'activity',
    route: 'activity',
    label: moteText('活动'),
    featureId: 'mote.activity',
    render: ({ api, onPage, onOpen }: PageProps) => <Activity api={api} onNavigate={onPage} onOpen={onOpen}/>,
  },
  {
    id: 'actions',
    route: 'actions',
    label: moteText('待办与日程'),
    featureId: 'mote.actions',
    render: ({ api, onOpen }: PageProps) => <Actions api={api} onOpen={onOpen}/>,
  },
];

export const work: BuiltinWebPlugin = { id: 'mote.work', pages };

export { Activity } from './Activity';
export { Actions } from './Actions';
export { ActionCapabilitySettings } from './ActionCapabilitySettings';
export { ActionDialog } from './ActionDialog';
export { ActionResults } from './ActionResults';
export { ActionTimeInformation, informationMatches } from './ActionTimeInformation';
export { Todos, type Todo } from './Todos';
export { WorkIssueNotice } from './WorkIssueNotice';
export { WorkProgress, WorkStateBadge, workStateLabels } from './WorkProgress';
export { OperationFeed, affectedResource, operationFeed } from './operation-feed';
