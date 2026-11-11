import {moteText} from '@mote/shared/i18n';
import React from 'react';
import type {PageEntry} from '../../features/types';

const PluginCenter=React.lazy(()=>import('./PluginCenter').then(module=>({default:module.PluginCenter})));

export const pluginCenterPage:PageEntry={
  id:'extensions',route:'system/plugins',aliases:['system/extensions'],label:moteText('插件中心'),section:'system',order:3,featureId:'mote.features',
  render:({api,onPage,viewScope})=><PluginCenter api={api} onPage={onPage} viewScope={viewScope}/>,
};
export const pages:PageEntry[]=[pluginCenterPage];
