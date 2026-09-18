import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher, fileWatchBackend, type FileWatchEvent } from '../src/file-watcher';

const supported = ['darwin', 'linux', 'win32'].includes(process.platform);
let roots: string[] = [];
let watchers: FileWatcher[] = [];

afterEach(async () => {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe('native file watcher', () => {
  it('maps supported operating systems to their native watcher backend', () => {
    expect(fileWatchBackend('darwin')).toBe('fsevents');
    expect(fileWatchBackend('linux')).toBe('inotify');
    expect(fileWatchBackend('win32')).toBe('read-directory-changes');
  });

  it.skipIf(!supported)('emits a dirty event for a generated fixture change', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-file-watcher-')));
    roots.push(root);
    const events: FileWatchEvent[] = [];
    let resolveEvent!: (event: FileWatchEvent) => void;
    const event = new Promise<FileWatchEvent>(resolve => { resolveEvent = resolve; });
    const watcher = new FileWatcher(value => { events.push(value); if (value.kind !== 'error') resolveEvent(value); });
    watchers.push(watcher);
    await watcher.setTargets([{ sourceId: 'local-synthetic-source', path: root }]);
    await writeFile(join(root, 'generated.txt'), 'synthetic fixture');
    const received = await Promise.race([
      event,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('native watcher did not emit')), 5000)),
    ]);
    expect(received.sourceId).toBe('local-synthetic-source');
    expect(received.backend).toBe(fileWatchBackend());
    expect(events.some(value => value.kind === 'error')).toBe(false);
  });
});
