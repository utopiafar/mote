import { moteText } from '@mote/shared/i18n';
import { pageRoutes } from '@mote/shared';
import React from 'react';
import type { PageEntry, PageProps } from '../../features/types';
import {useHashChoice} from '../../useHashChoice';
import type { BuiltinWebPlugin } from '../types';
import {aiAccessRoute} from '../agent-access/routes';
import { Connections, DevicePairing } from './Connections';
import {connectionCatalogRoute, ConnectionsPage} from './ConnectionsPage';
import { SourceCatalog } from './SourceCatalog';
import {readSource, readSetup, Sources} from './Sources';

const LarkSettings = React.lazy(() => import('./LarkSettings').then(module => ({ default: module.LarkSettings })));

export { Connections, DevicePairing } from './Connections';
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

function ConnectionWorkspace({api, onOpen, onPage}: PageProps) {
  const [source] = useHashChoice('sourceId', readSource);
  const [setup] = useHashChoice('setup', readSetup);
  return source || setup
    ? <Sources api={api} onOpen={onOpen} onImport={() => onPage('imports')}/>
    : <ConnectionsPage api={api}/>;
}

export const pages: PageEntry[] = [
  {
    id: 'sourceCatalog',
    route: connectionCatalogRoute,
    label: moteText('新建'),
    section: 'connections',
    order: 0.5,
    featureId: 'mote.sources',
    render: ({ api, onPage }: PageProps) => <SourceCatalog api={api} onPage={onPage}/>,
  },
  {
    id: 'sources',
    route: pageRoutes.connections,
    label: moteText('连接'),
    navItem: 'connections',
    section: 'connections',
    order: 0,
    featureId: 'mote.sources',
    render: (props: PageProps) => <ConnectionWorkspace {...props}/>,
  },
  {
    id: 'lark',
    route: pageRoutes.lark,
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
    route: aiAccessRoute,
    label: moteText('AI 接入'),
    section: 'connections',
    order: 2,
    featureId: 'mote.connections',
    render: ({ api, devices }: PageProps) => <Connections key="chatbot" mode="chatbot" api={api} serverUrl={window.location.origin} devices={devices}/>,
  },
  {
    id: 'deviceConnections',
    route: pageRoutes.connections + '/pair',
    label: moteText('连接设备'),
    section: 'library',
    order: 1,
    featureId: 'mote.connections',
    render: ({ api, devices }: PageProps) => <DevicePairing key="device" api={api} serverUrl={window.location.origin} devices={devices}/>,
  },
];

export const connections: BuiltinWebPlugin = { id: 'mote.connections', pages: connectionsPages };
