import { type SourceConnection } from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import { Ellipsis, Link2, Monitor, Plus, Smartphone } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { type Api, type Device } from '../../api';
import { LoadingText } from '../../Loading';
import { useForegroundResources } from '../../useForegroundResources';
import { useResource } from '../../useResource';
import { DevicePairingSheet, DeviceSheet, RecordingSourcesSheet } from './DeviceSheet';

/** The selection uses the exact query fields of /api/library/browse. */
export type SourceBarFilter = { deviceId: string; sourceId?: never } | { sourceId: string; deviceId?: never };

type SourceBarProps = {
    api: Api;
    serverUrl: string;
    filter?: SourceBarFilter;
    onFilterChange: (filter: SourceBarFilter | undefined) => void;
    revision?: number;
    /** The native host can supply a chip for this Mac using its own device identity. */
    localDevice?: { deviceId: string; content: ReactNode };
    /** Increment to open the existing pairing sheet from another empty-state action. */
    pairingRequest?: number;
    onOpen?: (ref: string) => void;
};

type DeviceConnection = {
    id: string;
    scope: string;
    label: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    revokedAt?: string;
};

type DeviceSource = {
    id: string;
    name: string;
    platform: string;
    report?: Device;
    connectionIds: string[];
};

type AbnormalStatus = 'paused' | 'offline' | 'error';
type OpenSheet = { api: Api; opener: HTMLButtonElement } &
    ({ type: 'pair' } | { type: 'settings'; deviceId: string } |
     { type: 'recording'; provider: string; name: string });

const devicesPath = '/api/devices';
const connectionsPath = '/api/connections';
const sourcesPath = '/api/sources';
const deviceOrder: readonly string[] = ['macos', 'android', 'ios', 'windows', 'linux'];
const statusLabels = { paused: '已暂停', offline: '已离线', error: '需要处理' } as const;
const chipShape = { borderRadius: 'var(--mote-radius-indicator)' };

function deviceSources(reports: Device[], connections: DeviceConnection[]) {
    const devices = new Map<string, DeviceSource>();
    for (const report of reports) {
        if (!deviceOrder.includes(report.platform)) continue;
        devices.set(report.deviceId, {
            id: report.deviceId, name: report.deviceName, platform: report.platform, report, connectionIds: [],
        });
    }

    const connectionsByDevice = new Map<string, DeviceConnection[]>();
    for (const connection of connections) {
        if (!connection.deviceId || !connection.platform || !deviceOrder.includes(connection.platform)) continue;
        if (connection.scope !== 'owner' && connection.scope !== 'collector') continue;
        const known = connectionsByDevice.get(connection.deviceId) ?? [];
        known.push(connection);
        connectionsByDevice.set(connection.deviceId, known);
    }
    for (const [id, known] of connectionsByDevice) {
        const active = known.filter(connection => !connection.revokedAt);
        const latest = active.at(-1);
        if (!latest) {
            devices.delete(id);
            continue;
        }
        const device = devices.get(id);
        devices.set(id, {
            id,
            name: device?.name ?? latest.deviceName ?? latest.label,
            platform: device?.platform ?? latest.platform!,
            report: device?.report,
            connectionIds: active.map(connection => connection.id),
        });
    }
    return [...devices.values()].sort((a, b) => deviceOrder.indexOf(a.platform) - deviceOrder.indexOf(b.platform));
}

function deviceStatus(report: Device | undefined, disconnected: boolean): AbnormalStatus | undefined {
    if (disconnected || report?.status === 'offline') return 'offline';
    if (report?.status === 'paused') return 'paused';
    if (report?.status === 'error' || report?.sync?.state === 'error') return 'error';
}

function serviceStatus(source: SourceConnection): AbnormalStatus | undefined {
    if (source.status?.state === 'error') return 'error';
    if (!source.enabled) return 'paused';
}

function FilterChip({ selected, status, onClick, icon, name }: {
    selected: boolean;
    status?: AbnormalStatus;
    onClick: () => void;
    icon: ReactNode;
    name: string;
}) {
    return <button type="button" className={selected ? 'button primary' : 'button'}
        style={{ ...chipShape, minWidth: 0, whiteSpace: 'normal' }}
        aria-pressed={selected} onClick={onClick}>
        {icon}
        <span style={{ overflowWrap: 'anywhere', textAlign: 'start' }}>{name}</span>
        {status && <small data-source-status={status} style={{ color: selected ? 'inherit' : 'var(--mote-muted)', whiteSpace: 'nowrap' }}>
            {moteText(statusLabels[status])}
        </small>}
    </button>;
}

export function SourceBar({ api, serverUrl, filter, onFilterChange, localDevice, pairingRequest, onOpen, revision }: SourceBarProps) {
    const [open, setOpen] = useState<OpenSheet>();
    const sheet = open?.api === api ? open : undefined;
    const pairing = sheet?.type === 'pair';
    const all = useRef<HTMLButtonElement>(null);
    const focusAll = useRef(false);
    const previousPairingRequest = useRef(pairingRequest);
    useLayoutEffect(() => {
        if (!sheet && focusAll.current) {
            focusAll.current = false;
            all.current?.focus({ preventScroll: true });
        }
    }, [sheet]);
    useEffect(() => {
        if (pairingRequest === undefined || previousPairingRequest.current === pairingRequest) return;
        previousPairingRequest.current = pairingRequest;
        if (all.current) setOpen({ api, type: 'pair', opener: all.current });
    }, [api, pairingRequest]);
    const reports = useResource<{ items: Device[]; disconnectedDeviceIds: string[] }>(api, devicesPath, 30_000, revision);
    const inventory = useResource<{ items: DeviceConnection[] }>(api, connectionsPath, pairing ? 3_000 : 30_000, revision);
    const sources = useResource<{ items: SourceConnection[] }>(api, sourcesPath, 30_000, revision);
    useForegroundResources(api, [devicesPath, connectionsPath, sourcesPath]);

    const devices = deviceSources(reports.data?.items ?? [], inventory.data?.items ?? []);
    const disconnected = new Set(reports.data?.disconnectedDeviceIds);
    const services = sources.data?.items.filter(source =>
        (source.platform === 'import' && source.kind !== 'upload') ||
        source.capabilities?.discovery === 'provider-list' ||
        source.kind === 'coding-agent',
    ) ?? [];
    const selectedDevice = sheet?.type === 'settings' ? devices.find(device => device.id === sheet.deviceId) : undefined;
    const failures = [reports, inventory, sources].filter(resource => resource.error !== undefined);
    const loading = [reports, inventory, sources].some(resource => resource.loading && !resource.data);

    return <>
        <div className="library-source-bar" role="group" aria-label={moteText('来源')} style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--mote-space-inline)',
        }}>
            <button ref={all} type="button" className={!filter ? 'button primary' : 'button'}
                style={chipShape} aria-pressed={!filter} onClick={() => onFilterChange(undefined)}>{moteText('全部')}</button>
            {localDevice?.content}
            {devices.filter(device => device.id !== localDevice?.deviceId).map(device => {
                const Icon = device.platform === 'android' || device.platform === 'ios' ? Smartphone : Monitor;
                return <span key={device.id} data-device-id={device.id} style={{ display: 'inline-flex', maxWidth: '100%' }}>
                    <FilterChip name={device.name} icon={<Icon size={16} aria-hidden="true" style={{ flexShrink: 0 }}/>}
                        selected={filter?.deviceId === device.id} status={deviceStatus(device.report, disconnected.has(device.id))}
                        onClick={() => onFilterChange({ deviceId: device.id })}/>
                    <button type="button" className="icon-button" aria-haspopup="dialog" title={moteText('更多选项')}
                        aria-label={moteText('{0} 的设备设置', device.name)}
                        onClick={event => setOpen({ api, type: 'settings', deviceId: device.id, opener: event.currentTarget })}>
                        <Ellipsis size={16} aria-hidden="true"/>
                    </button>
                </span>;
            })}
            {services.map(source => {
                const provider = source.kind.endsWith('.recordings') ? source.kind.slice(0, -'.recordings'.length) : undefined;
                return <span key={source.id} data-source-id={source.id} style={{ display: 'inline-flex', maxWidth: '100%' }}>
                    <FilterChip name={source.name} icon={<Link2 size={16} aria-hidden="true" style={{ flexShrink: 0 }}/>}
                        selected={filter?.sourceId === source.id} status={serviceStatus(source)}
                        onClick={() => onFilterChange({ sourceId: source.id })}/>
                    {provider && <button type="button" className="icon-button" aria-haspopup="dialog" title={moteText('更多选项')}
                        aria-label={moteText('{0} 的设置', source.name)}
                        onClick={event => setOpen({ api, type: 'recording', provider, name: source.name, opener: event.currentTarget })}>
                        <Ellipsis size={16} aria-hidden="true"/>
                    </button>}
                </span>;
            })}
            <button type="button" className="text-button" aria-haspopup="dialog"
                onClick={event => setOpen({ api, type: 'pair', opener: event.currentTarget })}>
                <Plus size={16} aria-hidden="true"/>{moteText('添加设备')}
            </button>
            {loading && <span role="status"><LoadingText/></span>}
        </div>
        {failures.length > 0 && <div className="notice error" role="alert">
            {moteText('状态读取失败。')}
            <button className="text-button" type="button" onClick={() => failures.forEach(resource => resource.refresh())}>
                {moteText('重新读取')}
            </button>
        </div>}
        {sheet?.type === 'pair' && <DevicePairingSheet api={api} serverUrl={serverUrl} devices={reports.data?.items ?? []}
            opener={sheet.opener} fallbackFocus={all.current} onClose={() => {
                setOpen(undefined);
                inventory.refresh();
            }}/>}
        {sheet?.type === 'settings' && selectedDevice && <DeviceSheet api={api} name={selectedDevice.name} report={selectedDevice.report}
            opener={sheet.opener} fallbackFocus={all.current} onClose={() => setOpen(undefined)} onOpen={onOpen}
            connectionIds={selectedDevice.connectionIds} onRevoked={() => {
                if (filter?.deviceId === selectedDevice.id) onFilterChange(undefined);
                focusAll.current = true;
                setOpen(undefined);
            }}/>}
        {sheet?.type === 'recording' && <RecordingSourcesSheet api={api} initialProvider={sheet.provider}
            opener={sheet.opener} fallbackFocus={all.current} onClose={() => setOpen(undefined)}
            onOpen={onOpen ?? (() => {})}/>}
    </>;
}
