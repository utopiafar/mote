import { moteText } from '@mote/shared/i18n';
import React from "react";
import { FeatureInventory } from '../FeatureInventory';
const Processing = React.lazy(()=>import('../Processing').then(module=>({default:module.Processing})));

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'extensions',route:'system/extensions',label:moteText('扩展能力'),section:'system',order:3,featureId:'mote.features',render:({api,onPage}:PageProps)=><><FeatureInventory api={api}/><Processing api={api} extensions onNavigate={onPage}/></>},
];
