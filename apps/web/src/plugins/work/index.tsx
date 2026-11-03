import { moteText } from '@mote/shared/i18n';
import React from 'react';
import type { PageEntry, PageProps } from '../../features/types';
import type { BuiltinWebPlugin } from '../types';

const Activity = React.lazy(() => import('./Activity').then(module => ({ default: module.Activity })));
const Actions = React.lazy(() => import('./Actions').then(module => ({ default: module.Actions })));

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
