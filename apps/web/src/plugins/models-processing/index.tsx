import {moteText} from '@mote/shared/i18n';
import React from 'react';
import type {PageEntry,PageProps} from '../../features/types';
import {ServerSettings} from '../../ServerSettings';
import type {BuiltinWebPlugin} from '../types';

const LazyProcessing = React.lazy(() => import('./Processing').then(module => ({default: module.Processing})));

export {ModelAssignments} from './ModelAssignments';
export {ModelAuthorizationSettings} from './ModelAuthorizationSettings';
export {ModelProfiles} from './ModelProfiles';
export {ModelSettingsEditor} from './ModelSettingsEditor';
export {modelSetupHref,ModelStartGuide} from './ModelStartGuide';
export {AutomaticActivitySettings} from './AutomaticActivitySettings';
export {AutomaticProcessing} from './AutomaticProcessing';
export {MaterialProcessing} from './MaterialProcessing';
export {Processing} from './Processing';
export {ProcessingOverview} from './ProcessingOverview';
export {useProcessingRelatedPages} from './ProcessingRelatedPages';
export {automaticProcessingPlan,processingConnectionKey} from './automatic-processing-plan';
export type {ProcessingAuthority,ProcessingConnection,ProcessingGrant,ProcessingKind,ProcessingScope} from './automatic-processing-plan';
export {createModelDraft,modelDraftChanged,modelSettingsRequest,retainedCredentialsNeedConfirmation} from './model-settings-form';
export type {CredentialAction,ModelSettingsDraft} from './model-settings-form';

/** Model connections, feature assignments, background grants and the ordinary
 * material processing settings live in one package. The processing task list
 * keeps its own server-contributed page identity. */
export const pages: PageEntry[] = [
  {
    id: 'settings',
    route: 'system/models',
    label: moteText('模型与服务'),
    section: 'system',
    order: 4,
    featureId: 'mote.models',
    render: ({api, onPage, refresh}: PageProps) => <ServerSettings api={api} onNavigate={onPage} onModelApplied={refresh}/>,
  },
];

export const processingPages: PageEntry[] = [
  {
    id: 'processing',
    route: 'system/processing',
    label: moteText('技术执行记录'),
    featureId: 'mote.processing',
    render: ({api, onPage}: PageProps) => <LazyProcessing api={api} onNavigate={onPage}/>,
  },
];

export const models: BuiltinWebPlugin = {id: 'mote.models', pages};
export const processing: BuiltinWebPlugin = {id: 'mote.processing', pages: processingPages};
