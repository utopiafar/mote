import { moteText } from '@mote/shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { DeviceOverview } from "../DeviceOverview";
import { type Api, type Device } from '../api';
import { devicePageAliases, devicePageRoute } from '../device-route';
import { resources } from '../resource-cache';
import type { PageEntry, PageProps } from './types';

const syncModes = {
    realtime: '实时同步',
    interval: '定时同步',
    batch: '批量同步',
    manual: '手动同步',
} as const;

export function DeviceSettings({ api, report, connectionIds, onRevoked }: {
    api: Api;
    report?: Device;
    connectionIds: readonly string[];
    onRevoked: () => void;
}) {
    const [review, setReview] = useState<readonly string[]>();
    const [removing, setRemoving] = useState(false);
    const [failed, setFailed] = useState(false);
    const request = useRef<AbortController>(null);
    useEffect(() => () => request.current?.abort(), [api]);

    async function revoke(ids: readonly string[]) {
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setRemoving(true);
        setFailed(false);
        try {
            for (const id of ids) {
                controller.signal.throwIfAborted();
                await api.request('/api/connections/' + encodeURIComponent(id), {
                    method: 'DELETE', signal: controller.signal,
                });
            }
            if (!controller.signal.aborted) onRevoked();
        } catch {
            if (!controller.signal.aborted) setFailed(true);
        } finally {
            resources(api).invalidate(key => key === '/api/connections');
            request.current = null;
            if (!controller.signal.aborted) {
                setRemoving(false);
                setReview(undefined);
            }
        }
    }

    return <div className="device-settings">
        <dl>
            <dt>{moteText('同步方式')}</dt>
            <dd>{report?.sync ? moteText(syncModes[report.sync.mode]) : moteText('未上报')}</dd>
        </dl>
        <p className="field-note">{moteText('在设备上暂停采集或更改同步方式。')}</p>
        {failed && <p className="notice error" role="alert">{moteText('操作失败')}</p>}
        {review ? <>
            <p>{moteText('移除后停止同步，已归档资料保留。')}</p>
            <div className="button-row">
                <button className="button subtle" type="button" disabled={removing} onClick={() => setReview(undefined)}>{moteText('取消')}</button>
                <button className="button danger" type="button" disabled={removing} onClick={() => void revoke(review)}>
                    {removing ? moteText('正在撤销…') : moteText('确认移除')}
                </button>
            </div>
        </> : connectionIds.length > 0 && <button className="button" type="button" onClick={() => {
            setFailed(false);
            setReview([...connectionIds]);
        }}>{failed ? moteText('重试') : moteText('移除设备')}</button>}
    </div>;
}

export const pages: PageEntry[] = [
    { id: 'devices', route: devicePageRoute, aliases: devicePageAliases, label: moteText('采集与设备'), section: 'connections', order: 1, featureId: 'mote.devices', render: ({ api,devices,onOpen,refresh,onPage }: PageProps) => (<DeviceOverview api={api} onOpen={onOpen} onRefresh={refresh} devices={devices} onConnect={() => onPage("deviceConnections")} onAdd={() => onPage("sourceCatalog")} onSources={() => onPage("sources")}/>) },
];
