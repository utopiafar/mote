import { moteText } from '@mote/shared/i18n';
import React from "react";
const Processing = React.lazy(()=>import('../Processing').then(module=>({default:module.Processing})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'processing',route:'system/processing',label:moteText('处理任务'),section:'system',order:2,featureId:'mote.processing',render:({api,onPage}:PageProps)=><Processing api={api} onNavigate={onPage}/>},
];
