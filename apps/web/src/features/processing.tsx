import { moteText } from '@mote/shared/i18n';
import React from "react";
const Activity = React.lazy(()=>import('../Activity').then(module=>({default:module.Activity})));
const Processing = React.lazy(()=>import('../Processing').then(module=>({default:module.Processing})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'activity',route:'activity',label:moteText('活动'),featureId:'mote.activity',render:({api,onPage,onOpen}:PageProps)=><Activity api={api} onNavigate={onPage} onOpen={onOpen}/>},
{id:'processing',route:'system/processing',label:moteText('技术执行记录'),featureId:'mote.processing',render:({api,onPage}:PageProps)=><Processing api={api} onNavigate={onPage}/>},
];
