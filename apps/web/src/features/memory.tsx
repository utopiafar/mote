import { moteText } from '@mote/shared/i18n';
import React from "react";

const Memories = React.lazy(()=>import('../Memories').then(module=>({default:module.Memories})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'memories',route:'library/memories',label:moteText('记忆'),section:'library',order:6,featureId:'mote.memory',render:({api,onOpen:setEvidenceId,range,rangeSelectionKey,timelineRevision,refresh}:PageProps)=><Memories api={api} range={range} rangeSelectionKey={rangeSelectionKey} refreshVersion={timelineRevision} onOpen={setEvidenceId} onChanged={refresh} />},
];
