import { moteText } from '@mote/shared/i18n';
import React from "react";
import { AdvancedConfiguration } from "../ServerSettings";
import {RuntimeSettings} from '../RuntimeSettings';
import {MaintenanceFrame} from '../MaintenanceFrame';
import {TrustedGithubPluginInstall} from '../plugins/plugin-center/TrustedGithubPluginInstall';
import {ActivityOverview} from '../plugins/work';
import {ProcessingStatus} from '../plugins/models-processing';

const Diagnostics = React.lazy(()=>import('../Diagnostics').then(module=>({default:module.Diagnostics})));

import type { PageEntry,PageProps } from './types';
import type {Page} from '../navigation';
import type {Api} from '../api';

/** Background activity and processing state live inside diagnostics; the
 * activity page keeps the full detail view and the processing page keeps
 * filters, pagination and per-step records. */
export function DiagnosticsBackground({api,onPage}:{api:Api;onPage:(page:Page)=>void}){
  return <section className="panel diagnostics-background">
    <div className="section-heading"><div><h2>{moteText('后台活动')}</h2></div></div>
    <ActivityOverview api={api} onPage={onPage}/>
    <div className="section-heading"><div><h2>{moteText('处理状态')}</h2></div></div>
    <ProcessingStatus api={api} onPage={onPage}/>
  </section>;
}

export const pages:PageEntry[]=[
{id:'developer',route:'system/diagnostics',label:moteText('运行与诊断'),section:'system',order:7,featureId:'mote.diagnostics',render:({api,status,onPage}:PageProps)=>status?<MaintenanceFrame title={moteText('运行与诊断')}><Diagnostics api={api} profile={status.profile} advanced={<RuntimeSettings api={api} kind="diagnostics"/>} deployment={<AdvancedConfiguration api={api} includeRuntime={false}/>}/><DiagnosticsBackground api={api} onPage={onPage}/><TrustedGithubPluginInstall api={api}/></MaintenanceFrame>:null},
];
