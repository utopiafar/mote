import { moteText } from '@mote/shared/i18n';
import { CodingUploads } from '../CodingUploads';
import type { PageEntry, PageProps } from './types';
export const pages: PageEntry[] = [
    { id: 'coding', route: 'library/coding', get label() { return moteText("Coding 会话同步状态"); }, featureId: 'mote.coding', requires: ['http:GET:/api/coding/uploads'], render: ({ api, onOpen }: PageProps) => <CodingUploads api={api} onOpen={onOpen}/> },
];
