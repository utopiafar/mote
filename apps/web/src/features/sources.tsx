import { moteText } from '@mote/shared/i18n';
import React from "react";
const LarkSettings = React.lazy(()=>import('../LarkSettings').then(module=>({default:module.LarkSettings})));

const Sources = React.lazy(()=>import('../Sources').then(module=>({default:module.Sources})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'sources',route:'connections',label:moteText('来源'),section:'connections',order:0,featureId:'mote.sources',render:({api,onPage,onOpen:setEvidenceId,setArchiveTab}:PageProps)=><Sources onBrowse={()=>{setArchiveTab("sources");onPage("archive");}} api={api} onOpen={setEvidenceId} onImport={()=>onPage("imports")} />},
{id:'lark',route:'connections/lark',label:moteText('飞书'),section:'connections',order:3,featureId:'mote.sources',render:({api,onPage}:PageProps)=><LarkSettings api={api} onBack={()=>onPage("settings")} onSources={()=>onPage("sources")}/>},
];
