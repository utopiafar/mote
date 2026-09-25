import { moteText } from '@mote/shared/i18n';
import React from "react";

const Connections = React.lazy(()=>import('../Connections').then(module=>({default:module.Connections})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'connections',route:'connections/access',label:moteText('对外授权'),section:'connections',order:2,featureId:'mote.connections',render:({api,devices}:PageProps)=><><Connections api={api} serverUrl={window.location.origin} devices={devices}/></>},
];
