import { moteText } from '@mote/shared/i18n';
import React from "react";
const PluginCenter = React.lazy(()=>import('../PluginCenter').then(module=>({default:module.PluginCenter})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'extensions',route:'system/plugins',aliases:['system/extensions'],label:moteText('插件'),section:'system',order:3,featureId:'mote.features',render:({api,onPage}:PageProps)=><PluginCenter api={api} onPage={onPage}/>},
];
