import {ScopedDevices} from '../ScopedSummary';
import { moteText } from '@mote/shared/i18n';
import { DeviceOverview } from "../DeviceOverview";
import type { PageEntry, PageProps } from './types';
export const pages: PageEntry[] = [
    { id: 'devices', route: 'connections/devices', label: moteText('采集与设备'), section: 'connections', order: 1, featureId: 'mote.devices', render: ({ api,devices, onPage }: PageProps) => api.connection?.mode==='web'?<ScopedDevices api={api} onConnect={()=>onPage('connections')}/>: (<DeviceOverview devices={devices} onConnect={() => onPage("connections")} onAdd={() => onPage("sourceCatalog")} onSources={() => onPage("sources")}/>) },
];
