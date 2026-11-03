import { moteText } from '@mote/shared/i18n';
import { MemoryRecordPanel } from '../features/memory-record';
import type { BuiltinWebPlugin } from './types';

export const savedRecordViews: BuiltinWebPlugin = {
  id: 'mote.saved-record-views',
  panels: [
    { id: 'memory.saved', kind: 'mote.memory', schemaVersion: 1, representation: 'saved-record', render: ({ value }) => <MemoryRecordPanel record={JSON.parse(value.text)}/> },
    { id: 'operation.saved', kind: 'mote.operation', schemaVersion: 1, representation: 'saved-record', render: ({ value }) => <details><summary>{moteText('保存记录（只读）')}</summary><pre className="feature-json">{value.text}</pre></details> },
  ],
};
