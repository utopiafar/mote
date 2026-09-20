import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileCatalogEntry, LocalFileCheckpoint } from './source-types';

export interface DirectoryCandidate {
  path: string; relativePath: string; fileId: string; birthtimeMs: number; size: number; mtimeMs: number; ctimeMs: number; quickHash: string;
}

const quickHash = (fileId: string, size: number, mtimeMs: number, ctimeMs: number): string => createHash('sha256').update(`${fileId}:${size}:${mtimeMs}:${ctimeMs}`).digest('hex');
const clone = (value: LocalFileCheckpoint): LocalFileCheckpoint => structuredClone(value);

/**
 * Durable, resumable directory enumeration state. It never decides whether
 * content is useful; it only advances a lexicographic directory cursor and
 * records filesystem metadata for the reconciliation scanner.
 */
export class DirectoryCatalog {
  private state: LocalFileCheckpoint;
  private rollback?:{state:Omit<LocalFileCheckpoint,'catalog'>;entries:Map<string,FileCatalogEntry|undefined>};
  private listing?:{path:string;entries:string[]};
  get inProgress(){return this.state.inProgress;}
  savepoint(){const {catalog,...state}=this.state;this.rollback={state:structuredClone(state),entries:new Map()};}
  previous(path:string){return this.rollback?.entries.has(path)?this.rollback.entries.get(path):this.state.catalog[path];}
  rollbackSavepoint(){if(!this.rollback)return;for(const [path,entry] of this.rollback.entries){if(entry)this.state.catalog[path]=entry;else delete this.state.catalog[path];}this.state={...this.rollback.state,catalog:this.state.catalog};this.rollback=undefined;this.listing=undefined;}
  private remember(path:string){if(this.rollback&&!this.rollback.entries.has(path))this.rollback.entries.set(path,this.state.catalog[path]);}
  constructor(private readonly root: string, previous?: LocalFileCheckpoint) {
    this.state = previous && previous.version === 1 && previous.root === root ? clone(previous) : {
      version: 1, root, scanNumber: 0, scanStartedAt: new Date(0).toISOString(), initialized: false,
      inProgress: false, pendingDirectories: [], catalog: {},
    };
  }

  checkpoint(): LocalFileCheckpoint { return clone(this.state); }
  restore(checkpoint: LocalFileCheckpoint): void { this.state = clone(checkpoint); this.listing=undefined; }
  get catalog(): Readonly<Record<string, FileCatalogEntry>> { return this.state.catalog; }

  observe(candidate: DirectoryCandidate): void {
    this.begin();
    this.remember(candidate.relativePath);
    this.state.catalog[candidate.relativePath] = {
      ...(this.state.catalog[candidate.relativePath] ?? {}), relativePath: candidate.relativePath, fileId: candidate.fileId,
      birthtimeMs: candidate.birthtimeMs, size: candidate.size, mtimeMs: candidate.mtimeMs, ctimeMs: candidate.ctimeMs,
      quickHash: candidate.quickHash, lastSeenScan: this.state.scanNumber,
      syncState: this.state.catalog[candidate.relativePath]?.syncState ?? 'pending',
    };
  }

  begin(): void {
    if (this.state.inProgress) return;
    this.listing=undefined;
    this.state = {
      ...this.state,
      scanNumber: this.state.scanNumber + 1,
      scanStartedAt: new Date().toISOString(),
      inProgress: true,
      pendingDirectories: [this.root],
      activeDirectory: undefined,
      nextFile: undefined,
    };
  }

  async next(limit: number, excludedPaths: readonly string[]): Promise<{ candidates: DirectoryCandidate[]; complete: boolean; faulted: boolean; skipped: number }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Directory catalog batch limit is invalid');
    this.begin();
    const candidates: DirectoryCandidate[] = [];
    let skipped = 0;
    let complete = true; let faulted = false;
    const isExcluded = (relativePath: string) => relativePath.split('/').some(part => part.startsWith('.')) || excludedPaths.some(value => relativePath === value || relativePath.startsWith(value + '/'));
    while (candidates.length < limit && (this.state.activeDirectory || this.state.pendingDirectories.length)) {
      if (!this.state.activeDirectory) this.state.activeDirectory = { path: this.state.pendingDirectories.shift()! };
      const active = this.state.activeDirectory;
      let entries: string[];
      try { if(this.listing?.path!==active.path)this.listing={path:active.path,entries:(await readdir(active.path)).sort()};entries=this.listing.entries; }
      catch { complete = false; faulted = true; this.state.activeDirectory = undefined; continue; }
      const remaining = entries.filter(entry => !active.after || entry > active.after);
      if (!remaining.length) { this.state.activeDirectory = undefined; continue; }
      for (const name of remaining) {
        if (candidates.length >= limit) break;
        active.after = name;
        const path = join(active.path, name), relativePath = relative(this.root, path).split('\\').join('/');
        if (isExcluded(relativePath)) { skipped++; continue; }
        let info;
        try { info = await lstat(path); }
        catch { complete = false; faulted = true; skipped++; continue; }
        if (info.isSymbolicLink()) { skipped++; continue; }
        if (info.isDirectory()) { this.state.pendingDirectories.push(path); continue; }
        if (!info.isFile()) { skipped++; continue; }
        const fileId = `${info.dev}:${info.ino}`;
        candidates.push({ path, relativePath, fileId, birthtimeMs: info.birthtimeMs, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, quickHash: quickHash(fileId, info.size, info.mtimeMs, info.ctimeMs) });
        this.remember(relativePath);
        this.state.catalog[relativePath] = {
          ...(this.state.catalog[relativePath] ?? {}), relativePath, fileId, size: info.size,
          birthtimeMs: info.birthtimeMs, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, quickHash: quickHash(fileId, info.size, info.mtimeMs, info.ctimeMs),
          lastSeenScan: this.state.scanNumber, syncState: this.state.catalog[relativePath]?.syncState ?? 'pending',
        };
        this.state.nextFile = relativePath;
      }
    }
    if (!this.state.activeDirectory && !this.state.pendingDirectories.length) this.state.inProgress = false;
    return { candidates, complete: complete && !this.state.inProgress, faulted, skipped };
  }

  markContent(relativePath: string, contentHash: string | undefined, syncState: FileCatalogEntry['syncState'] = 'synced'): void {
    const entry = this.state.catalog[relativePath];
    if (!entry) return;
    this.remember(relativePath);
    this.state.catalog[relativePath] = { ...entry, ...(contentHash ? { contentHash } : {}), syncState };
  }

  finishReconciliation(): string[] {
    const removed: string[] = [];
    if (this.state.inProgress) return removed;
    this.state.initialized = true;
    for (const [relativePath, entry] of Object.entries(this.state.catalog)) {
      if (entry.lastSeenScan !== this.state.scanNumber) { removed.push(relativePath); delete this.state.catalog[relativePath]; }
    }
    return removed;
  }
}
