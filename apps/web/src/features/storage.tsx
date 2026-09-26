import { moteText } from '@mote/shared/i18n';
import React from "react";
const StorageStatistics = React.lazy(()=>import('../StorageStatistics').then(module=>({default:module.StorageStatistics})));
const ContentStorage = React.lazy(()=>import('../ContentStorage').then(module=>({default:module.ContentStorage})));

import { PageBack } from "../DeviceOverview";

import { Vault } from '../Vault';
import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'vault',route:'system/storage',label:moteText('存储与索引'),section:'system',order:6,featureId:'mote.storage',render:({api,status,onPage,refresh,disconnect}:PageProps)=>status?(
                        <><PageBack title={moteText("设置")} onBack={()=>onPage("settings")}/><ContentStorage api={api} onChange={refresh}/><Vault
                          api={api}
                          status={status}
                          refresh={refresh}
                          disconnect={disconnect}
                        /></>
                      ):null},
{id:'statistics',route:'system',label:moteText('运行状态'),section:'system',order:0,featureId:'mote.storage',render:({api,onPage}:PageProps)=><StorageStatistics api={api} onUsage={()=>onPage("usage")}/>},
];
