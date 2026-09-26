import { moteText } from '@mote/shared/i18n';

import { ServerSettings } from "../ServerSettings";

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'settings',route:'system/models',label:moteText('模型与服务'),section:'system',order:4,featureId:'mote.models',render:({api,onPage,refresh}:PageProps)=><ServerSettings api={api} onNavigate={onPage} onModelApplied={refresh}/>},
];
