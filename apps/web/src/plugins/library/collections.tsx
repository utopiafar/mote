import { moteText } from '@mote/shared/i18n';
import React from 'react';
import { useResource } from '../../useResource';
import { queryString, errorMessage, type Activity } from '../../api';
import { ErrorNotice, Spinner } from '../../shell-components';
import { ActivitySummary, RecordTimeline } from './Archive';
import { Files } from '../intake';
import { LibraryMaterials } from './LibraryBrowse';
import { CodingUploads } from '../../CodingUploads';
import { webFeatures } from '../../features/registry';
import { canonicalDestination, workspaceHash } from '../../workspace-route';
import { MediaActivitySummary } from './Media';
import type { CollectionEntry, CollectionProps } from '../../features/types';
const CaptureSessions = React.lazy(() => import('./CaptureSessions').then(module => ({ default: module.CaptureSessions })));
const Sources = React.lazy(() => import('../sources/Sources').then(module => ({ default: module.Sources })));
const Memories = React.lazy(() => import('../memory/Memories').then(module => ({ default: module.Memories })));
function ActivityCollection({ api, range, revision, rangeSelectionKey }: CollectionProps) {
    const continuity=rangeSelectionKey===undefined?undefined:JSON.stringify([rangeSelectionKey,range.deviceId]);
    const activity = useResource<Activity>(api, '/api/activity' + queryString(range), undefined, revision, continuity);
    if (activity.error)
        return <ErrorNotice text={errorMessage(activity.error)} retry={activity.refresh}/>;
    if (!activity.data)
        return <Spinner />;
    return <ActivitySummary activity={activity.data}/>;
}
export const builtinCollections: CollectionEntry[] = [
    { id: 'coding-status', featureId: 'mote.coding', get label() { return moteText("Coding 会话同步状态"); }, order: 7, group: 'processing', layout: 'standalone', usesTimeRange: false, requires: ['http:GET:/api/coding/uploads'], render: props => <CodingUploads api={props.api} embedded onOpen={props.onOpen}/> },
    { id: 'records', usesTimeRange: false, featureId: 'mote.capture', label: moteText('原始采集记录'), order: 1, group: 'records', layout: 'browser', requires: ['http:GET:/api/capture-browser/timeline','http:GET:/api/capture-browser/timeline/members'], render: props => <RecordTimeline {...props} library onOpen={props.onOpen} selectedReference={props.selectedReference} onBrowseChanged={props.onBrowseChanged}/> },
    { id: 'materials', usesTimeRange: false, featureId: 'mote.materials', label: moteText('全部资料'), order: 0, group: 'browse', layout: 'browser', requires: ['http:GET:/api/library/browse'], render: props => <LibraryMaterials {...props} selected={props.selectedReference} onSelect={props.onOpen}/> },
    { id: 'segments', usesTimeRange: false, featureId: 'mote.capture', label: moteText('片段'), order: 1.5, group: 'records', render: props => <CaptureSessions {...props}/> },
    { id: 'sources', usesTimeRange: false, featureId: 'mote.sources', label: moteText('来源资料'), order: 2, group: 'views', render: props => <Sources {...props} mode="library" onImport={() => { location.hash = '/library/import'; }}/> },
    { id: 'files', usesTimeRange: false, featureId: 'mote.files', label: moteText('文件与录音'), order: 3, group: 'views', render: props => <Files {...props}/> },
    { id: 'activity', featureId: 'mote.capture', label: moteText('应用活动'), order: 4, group: 'views', render: props => <ActivityCollection {...props}/> },
    { id: 'media', featureId: 'mote.media', label: moteText('媒体播放'), order: 5, group: 'views', render: props => <MediaActivitySummary {...props}/> },
    { id: 'memories', featureId: 'mote.memory', label: moteText('记忆'), order: 6, group: 'views', render: props => <Memories {...props} embedded refreshVersion={props.revision}/> },
];
