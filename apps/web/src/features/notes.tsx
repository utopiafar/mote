import { moteText } from '@mote/shared/i18n';
import React from "react";

const Notes = React.lazy(()=>import('../Notes').then(module=>({default:module.Notes})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'notes',route:'library/notes',label:moteText('随手记'),section:'library',order:5,featureId:'mote.notes',render:({api,onOpen:setEvidenceId,timelineRevision,refresh}:PageProps)=><Notes key={window.location.origin} api={api} namespace={window.location.origin} revision={timelineRevision} onOpen={setEvidenceId} onSaved={refresh} />},
];
