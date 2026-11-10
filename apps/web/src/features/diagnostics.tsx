import { moteText } from '@mote/shared/i18n';
import React from "react";
import { AdvancedConfiguration } from "../ServerSettings";
import {RuntimeSettings} from '../RuntimeSettings';
import {MaintenanceFrame} from '../MaintenanceFrame';
import {TrustedGithubPluginInstall} from '../plugins/plugin-center/TrustedGithubPluginInstall';

const Diagnostics = React.lazy(()=>import('../Diagnostics').then(module=>({default:module.Diagnostics})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'developer',route:'system/diagnostics',label:moteText('运行与诊断'),section:'system',order:7,featureId:'mote.diagnostics',render:({api,status}:PageProps)=>status?<MaintenanceFrame title={moteText('运行与诊断')}><Diagnostics api={api} profile={status.profile} advanced={<RuntimeSettings api={api} kind="diagnostics"/>} deployment={<AdvancedConfiguration api={api} includeRuntime={false}/>}/><TrustedGithubPluginInstall api={api}/></MaintenanceFrame>:null},
];
