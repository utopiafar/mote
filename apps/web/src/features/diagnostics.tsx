import { moteText } from '@mote/shared/i18n';
import React from "react";
import { PageBack } from "../DeviceOverview";
import { AdvancedConfiguration } from "../ServerSettings";

const Diagnostics = React.lazy(()=>import('../Diagnostics').then(module=>({default:module.Diagnostics})));
const SoftwareUpdate = React.lazy(()=>import('../SoftwareUpdate').then(module=>({default:module.SoftwareUpdate})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'developer',route:'system/diagnostics',label:moteText('诊断与更新'),section:'system',order:7,featureId:'mote.diagnostics',render:({api,status,onPage}:PageProps)=>status?<><PageBack title={moteText("设置")} onBack={()=>onPage("settings")}/><div className="page-heading"><div className="eyebrow">{moteText("开发与维护")}</div><h1>{moteText("诊断与更新")}</h1><p>{moteText("查看运行诊断，按需调整日志与高级部署配置。")}</p></div><SoftwareUpdate api={api}/><Diagnostics api={api} profile={status.profile}/><AdvancedConfiguration api={api}/></>:null},
];
