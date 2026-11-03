import { moteText } from '@mote/shared/i18n';
import React from 'react';
import type { PageEntry, PageProps } from '../../features/types';
import type { BuiltinWebPlugin } from '../types';
import { Connections } from './Connections';
import { SourceCatalog } from './SourceCatalog';
import { Sources } from './Sources';

const LarkSettings = React.lazy(() => import('./LarkSettings').then(module => ({ default: module.LarkSettings })));
const RecordingsSettings = React.lazy(() => import('../../RecordingsSettings').then(module => ({ default: module.RecordingsSettings })));

export { Connections } from './Connections';
export { Gmail } from './Gmail';
export { GoogleCalendarSettings } from './GoogleCalendarSettings';
export { LarkJobStatus, LarkSettings, larkError } from './LarkSettings';
export { RecordingAuthorization } from './RecordingAuthorization';
export { RawRecording, RecordingTools, rawTranscriptFromTar } from './RecordingTools';
export { SourceCatalog } from './SourceCatalog';
export { SourceContextEditor, SourceContextFields, useSourceContextDraft, type SourceContextDraft } from './SourceContextEditor';
export { SourceDisconnectReview } from './SourceDisconnectReview';
export { Sources } from './Sources';
export {
  recordingSourcePlugin,
  sourcePluginBound,
  sourcePluginFor,
  sourcePluginForSetup,
  sourcePluginState,
  sourcePluginStateLabel,
  sourcePluginStatus,
  sourcePlugins,
  type SourceCatalogStatus,
  type SourcePlugin,
  type SourcePluginSettingsContext,
  type SourcePluginSetupContext,
  type SourcePluginStateContext,
} from './registry';

export const pages: PageEntry[] = [
  {
    id: 'sourceCatalog',
    route: 'connections/add',
    label: moteText('新增数据源'),
    section: 'connections',
    order: 0.5,
    featureId: 'mote.sources',
    render: ({ api, onPage }: PageProps) => <SourceCatalog api={api} onPage={onPage}/>,
  },
  {
    id: 'recordings',
    route: 'connections/recordings',
    label: moteText('录音归档'),
    section: 'connections',
    order: 4,
    featureId: 'mote.sources',
    render: ({ api, onPage, onOpen }: PageProps) => <RecordingsSettings onOpen={onOpen} api={api} onSources={() => onPage('sources')} onAdd={() => onPage('sourceCatalog')}/>,
  },
  {
    id: 'sources',
    route: 'connections',
    label: moteText('来源'),
    section: 'connections',
    order: 0,
    featureId: 'mote.sources',
    render: ({ api, onPage, onOpen: setEvidenceId, setArchiveTab }: PageProps) => <Sources onAdd={() => onPage('sourceCatalog')} onBrowse={() => { setArchiveTab('sources'); onPage('archive'); }} api={api} onOpen={setEvidenceId} onImport={() => onPage('imports')}/>,
  },
  {
    id: 'lark',
    route: 'connections/lark',
    label: moteText('飞书'),
    section: 'connections',
    order: 3,
    featureId: 'mote.sources',
    render: ({ api, onPage }: PageProps) => <LarkSettings api={api} onSources={() => onPage('sources')}/>,
  },
];

/** The sources package owns the source directory, connector setup, account
 * scope, contextual prose and device/AI access settings. Source-specific
 * setup and settings surfaces are contributed through sourcePlugins. */
export const sources: BuiltinWebPlugin = { id: 'mote.sources', pages };

export const connectionsPages: PageEntry[] = [
  {
    id: 'connections',
    route: 'connections/access',
    label: moteText('AI 接入'),
    section: 'connections',
    order: 2,
    featureId: 'mote.connections',
    render: ({ api, devices }: PageProps) => <Connections key="chatbot" mode="chatbot" api={api} serverUrl={window.location.origin} devices={devices}/>,
  },
  {
    id: 'deviceConnections',
    route: 'connections/pair',
    label: moteText('连接设备'),
    section: 'connections',
    order: 1,
    featureId: 'mote.connections',
    render: ({ api, devices }: PageProps) => <Connections key="device" mode="device" api={api} serverUrl={window.location.origin} devices={devices}/>,
  },
];

export const connections: BuiltinWebPlugin = { id: 'mote.connections', pages: connectionsPages };
