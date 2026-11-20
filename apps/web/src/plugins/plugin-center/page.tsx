import {moteText} from '@mote/shared/i18n';
import {pageRoutes} from '@mote/shared';
import React from 'react';
import type {PageEntry} from '../../features/types';

const PluginCenter=React.lazy(()=>import('./PluginCenter').then(module=>({default:module.PluginCenter})));

export const pluginCenterPage:PageEntry={
  id:'extensions',route:pageRoutes.skills,aliases:['system/extensions'],navItem:'skills',label:moteText('插件中心'),section:'system',order:3,featureId:'mote.features',
  render:({api,onPage,viewScope})=><PluginCenter api={api} onPage={onPage} viewScope={viewScope}/>,
};
export const pages:PageEntry[]=[pluginCenterPage];
