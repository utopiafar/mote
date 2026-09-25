import { moteText } from '@mote/shared/i18n';
import React from "react";
const Actions = React.lazy(()=>import('../Actions').then(module=>({default:module.Actions})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'actions',route:'actions',label:moteText('行动'),featureId:'mote.actions',render:({api,onOpen:setEvidenceId}:PageProps)=><Actions api={api} onOpen={setEvidenceId}/>},
];
