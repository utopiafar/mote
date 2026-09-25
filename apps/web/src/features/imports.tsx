import { moteText } from '@mote/shared/i18n';
import React from "react";

const Imports = React.lazy(()=>import('../Imports').then(module=>({default:module.Imports})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'imports',route:'library/import',label:moteText('导入'),section:'library',order:8,featureId:'mote.imports',render:({api,onPage,onOpen:setEvidenceId,timelineRevision,refresh}:PageProps)=><Imports api={api} refreshVersion={timelineRevision} onOpen={setEvidenceId} onMemories={()=>onPage("memories")} onSettings={()=>onPage("settings")} onChanged={refresh}/>},
];
