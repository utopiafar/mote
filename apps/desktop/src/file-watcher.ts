import { watch as nativeWatch } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';

/** The libuv backends used by Node's fs.watch on the supported platforms. */
export type FileWatchBackend = 'fsevents' | 'inotify' | 'read-directory-changes' | 'native';
export type FileWatchEvent = { sourceId: string; root: string; path?: string; backend: FileWatchBackend; kind: 'change' | 'rename' | 'error' };
export type FileWatchListener = (event: FileWatchEvent) => void;
export interface WatchTarget { sourceId: string; path: string }
type ActiveWatcher = { targetPath: string; close: () => void | Promise<void> };

export function fileWatchBackend(platform = process.platform): FileWatchBackend {
  if (platform === 'darwin') return 'fsevents';
  if (platform === 'linux') return 'inotify';
  if (platform === 'win32') return 'read-directory-changes';
  return 'native';
}

/**
 * Thin platform-neutral wrapper around Node/libuv's native filesystem watcher.
 * It deliberately reports only a dirty source. The reconciliation scanner owns
 * path validation, filtering, metadata comparison and content reads.
 */
export class FileWatcher {
  private readonly watchers = new Map<string, ActiveWatcher>();
  private readonly backend: FileWatchBackend;
  constructor(private readonly listener: FileWatchListener, platform = process.platform) { this.backend = fileWatchBackend(platform); }
  get platformBackend(): FileWatchBackend { return this.backend; }

  async setTargets(targets: readonly WatchTarget[]): Promise<void> {
    const desired = new Map(targets.map(target => [target.sourceId, target]));
    for (const sourceId of [...this.watchers.keys()]) if (!desired.has(sourceId)) this.closeSource(sourceId);
    for (const target of desired.values()) {
      const existing = this.watchers.get(target.sourceId);
      if (existing?.targetPath === target.path) continue;
      if (existing) this.closeSource(target.sourceId);
      await this.openSource(target);
    }
  }

  closeSource(sourceId: string): void {
    const watcher = this.watchers.get(sourceId);
    if (!watcher) return;
    this.watchers.delete(sourceId);
    void Promise.resolve(watcher.close()).catch(() => undefined);
  }

  close(): void { for (const sourceId of [...this.watchers.keys()]) this.closeSource(sourceId); }

  private async openSource(target: WatchTarget): Promise<void> {
    let selected: string;
    try {
      const info = await lstat(target.path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('watch target is not a regular path');
      selected = await realpath(target.path);
      if (selected !== target.path) throw new Error('watch target changed');
    } catch {
      this.listener({ sourceId: target.sourceId, root: target.path, backend: this.backend, kind: 'error' });
      return;
    }
    try {
      const info = await lstat(selected);
      if (this.backend === 'fsevents') {
        // fsevents is an optional, macOS-only native dependency. Keeping it
        // dynamic means Linux and Windows never load the incompatible addon.
        const fsevents = await import('fsevents');
        const stop = fsevents.watch(selected, (path, flags) => {
          const kind = flags & (fsevents.constants.ItemRemoved | fsevents.constants.ItemRenamed) ? 'rename' : 'change';
          this.listener({ sourceId: target.sourceId, root: selected, path, backend: this.backend, kind });
        });
        this.watchers.set(target.sourceId, { targetPath: target.path, close: stop });
        return;
      }
      const watcher = nativeWatch(selected, { persistent: false, recursive: info.isDirectory() }, (eventType, filename) => {
          const path = filename || undefined;
          this.listener({ sourceId: target.sourceId, root: selected, ...(path ? { path } : {}), backend: this.backend, kind: eventType === 'rename' ? 'rename' : 'change' });
        });
      const active: ActiveWatcher = { targetPath: target.path, close: () => watcher.close() };
      watcher.on('error', () => {
        this.closeSource(target.sourceId);
        this.listener({ sourceId: target.sourceId, root: selected, backend: this.backend, kind: 'error' });
      });
      this.watchers.set(target.sourceId, active);
    } catch {
      this.listener({ sourceId: target.sourceId, root: selected, backend: this.backend, kind: 'error' });
    }
  }
}
