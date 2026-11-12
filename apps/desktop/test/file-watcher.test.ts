import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
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

  it('serializes overlapping target updates so re-enabling never opens a second watcher', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-file-watcher-targets-')));
    roots.push(root);
    const first = join(root, 'generated-first'), second = join(root, 'generated-second');
    await mkdir(first); await mkdir(second);
    const watcher = new FileWatcher(() => {});
    watchers.push(watcher);
    // This case owns target reconciliation; it does not need native events.
    const open = vi.spyOn(watcher as any, 'openSource').mockImplementation(async (target: {sourceId: string; path: string}) => {
      (watcher as any).watchers.set(target.sourceId, {targetPath: target.path, close: () => undefined});
    });
    const firstTarget = {sourceId: 'local-first', path: first};
    const secondTarget = {sourceId: 'local-second', path: second};
    await Promise.all([watcher.setTargets([firstTarget, secondTarget]), watcher.setTargets([firstTarget, secondTarget])]);
    expect(open).toHaveBeenCalledTimes(2);
    expect([...(watcher as any).watchers.keys()]).toEqual(['local-first', 'local-second']);

    await watcher.setTargets([secondTarget]);
    expect([...(watcher as any).watchers.keys()]).toEqual(['local-second']);

    await watcher.setTargets([firstTarget, secondTarget]);
    expect(open).toHaveBeenCalledTimes(3);
    expect([...(watcher as any).watchers.keys()].sort()).toEqual(['local-first', 'local-second']);
  });

  it('reopens a watcher when the same path resolves to a different root identity', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-file-watcher-remount-')));
    roots.push(root);
    const events: FileWatchEvent[] = [];
    const watcher = new FileWatcher(event => events.push(event));
    watchers.push(watcher);
    const open = vi.spyOn(watcher as any, 'openSource').mockImplementation(async (target: {sourceId: string; path: string}) => {
      const info = await lstat(target.path);
      (watcher as any).watchers.set(target.sourceId, {targetPath: target.path, identity: `${info.dev}:${info.ino}`, close: () => undefined});
    });
    const target = {sourceId: 'local-generated-remount', path: root};
    await watcher.setTargets([target]);
    expect(open).toHaveBeenCalledTimes(1);
    const saved = root + '-saved'; await rename(root, saved); await mkdir(root);
    try {
      await watcher.setTargets([target]);
      expect(open).toHaveBeenCalledTimes(2);
      expect(events).toContainEqual(expect.objectContaining({sourceId: target.sourceId, kind: 'rename'}));
    } finally { await rm(root, {recursive: true, force: true}); await rename(saved, root); }
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
