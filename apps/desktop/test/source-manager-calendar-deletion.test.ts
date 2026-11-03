import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSourceManager } from '../src/source-manager';
import { SourceAdapterRegistry } from '../src/source-adapters';
import { DEFAULT_SOURCE_OPTIONS, type LocalSource, type ScannedItem } from '../src/source-types';
import { defaultConfig } from '../src/config';

let directory: string;
const managers: LocalSourceManager[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-managed-calendar-')); });
afterEach(async () => {
  for (const manager of managers) await manager.close();
  managers.length = 0;
  await rm(directory, { recursive: true, force: true });
});

const calendar = (): ScannedItem => ({
  externalId: 'calendar:generated-pending',
  title: 'Generated calendar entry',
  text: '',
  kind: 'calendar',
  layer: 'snapshot',
  calendar: { start: '2026-09-01T00:00:00Z', end: '2026-09-01T01:00:00Z', allDay: false, status: 'confirmed' },
  deleted: false,
});

// The managed path (LocalSourceManager.run + flushPending) never calls syncScan.
it('queues an offline calendar deletion through the managed stage path', async () => {
  let present = true;
  const adapters = new SourceAdapterRegistry();
  adapters.register({
    kind: 'local-calendar', version: 1, watchesPath: false, tracksDeletions: true, allowsArchive: false,
    validateConfiguration() {},
    async scan(): Promise<{ version: number; scan: { items: ScannedItem[]; seen: string[]; complete: boolean; skipped: number } }> {
      const items = present ? [calendar()] : [];
      return { version: 1, scan: { items, seen: items.map(item => item.externalId), complete: true, skipped: 0 } };
    },
  });
  const app = new LocalSourceManager(join(directory, 'sources'), { serverUrl: '', token: '', deviceId: defaultConfig().deviceId }, '/must-not-be-invoked-helper', true, undefined, adapters);
  managers.push(app);
  await app.initialize();
  await app.addAdapterSource({ kind: 'local-calendar', name: 'Generated calendar' } as unknown as LocalSource, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: true });
  await app.sync(true);
  expect(app.pendingContent().some(row => row.item.externalId === 'calendar:generated-pending' && !row.item.deleted)).toBe(true);

  // The event disappears while the client is offline; the next managed scan must
  // queue its deletion instead of waiting for another scan or a syncScan caller.
  present = false;
  await app.sync(true);
  const queued = app.pendingContent().filter(row => row.item.externalId === 'calendar:generated-pending');
  expect(queued.some(row => row.item.deleted)).toBe(true);
}, 20000);
