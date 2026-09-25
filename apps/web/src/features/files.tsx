import { moteText } from '@mote/shared/i18n';

import { Files } from '../Files';

import type { PageEntry,PageProps } from './types';

export const pages:PageEntry[]=[
{id:'files',route:'library/files',label:moteText('文件与录音'),section:'library',order:4,featureId:'mote.files',render:({api,onOpen:setEvidenceId}:PageProps)=><Files api={api} onOpen={setEvidenceId}/>},
];
