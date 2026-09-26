import { moteText } from '@mote/shared/i18n';

import { DeviceOverview } from "../DeviceOverview";

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'devices',route:'connections/devices',label:moteText('设备'),section:'connections',order:1,featureId:'mote.devices',render:({devices,onPage}:PageProps)=>(
                        <DeviceOverview devices={devices} onConnect={()=>onPage("connections")} />
                      )},
];
