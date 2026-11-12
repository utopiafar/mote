import { createHash } from 'node:crypto';
import type {Stats} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileCatalogEntry, FileScanDegraded, LocalFileCheckpoint } from './source-types';

export interface DirectoryCandidate {
  path: string; relativePath: string; fileId: string; birthtimeMs: number; size: number; mtimeMs: number; ctimeMs: number; quickHash: string; nlink?: number;
}

const quickHash = (fileId: string, size: number, mtimeMs: number, ctimeMs: number): string => createHash('sha256').update(`${fileId}:${size}:${mtimeMs}:${ctimeMs}`).digest('hex');
const clone = (value: LocalFileCheckpoint): LocalFileCheckpoint => structuredClone(value);
const identityOf = (info: Stats): string => `${info.dev}:${info.ino}`;
const severity: Record<FileScanDegraded, number> = { scan_incomplete: 0, permission_denied: 1, root_changed: 2, root_unavailable: 3 };
const fileFault = (error: unknown): FileScanDegraded => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'scan_incomplete';
};
/** A failed root check is a durable attempt, never evidence that its files vanished. */
export function degradedFileCheckpoint(previous: LocalFileCheckpoint, reason: FileScanDegraded): LocalFileCheckpoint {
  return { ...clone(previous), scanFaulted: true, lastScanComplete: false, degradedReason: reason, lastScanAttemptAt: new Date().toISOString() };
}

/**
 * Durable, resumable directory enumeration state. It never decides whether
 * content is useful; it only advances a lexicographic directory cursor and
 * records filesystem metadata for the reconciliation scanner.
 */
export class DirectoryCatalog {
  private state: LocalFileCheckpoint;
  private changes=new Map<string,FileCatalogEntry|undefined>();
  private baseCatalog:Record<string,FileCatalogEntry>={};
  private rollback?:{state:Omit<LocalFileCheckpoint,'catalog'>;entries:Map<string,FileCatalogEntry|undefined>};
  private listing?:{path:string;entries:string[];position:number};
  private readonly priorPaths:Set<string>;
  private rootChecked=false;
  private rootFailed=false;
  private rootIdentityChanged=false;
  private rootChangedMidScan=false;
  private observedRootIdentity?:string;
  private reconciled=false;
  get inProgress(){return this.state.inProgress;}
  get degraded(){return this.state.degradedReason;}
  /** A complete enumeration may still withhold removals while a changed root is verified. */
  get lastReconciliationComplete(){return this.reconciled;}
  savepoint(){const {catalog,...state}=this.state;this.rollback={state:structuredClone(state),entries:new Map()};}
  previous(path:string){return this.rollback?.entries.has(path)?this.rollback.entries.get(path):this.state.catalog[path];}
  rollbackSavepoint(){if(!this.rollback)return;for(const [path,entry] of this.rollback.entries){if(entry)this.state.catalog[path]=entry;else delete this.state.catalog[path];}this.state={...this.rollback.state,catalog:this.state.catalog};this.rollback=undefined;this.listing=undefined;this.reconciled=false;}
  private remember(path:string){if(this.rollback&&!this.rollback.entries.has(path))this.rollback.entries.set(path,this.state.catalog[path]);}
  constructor(private readonly root: string, previous?: LocalFileCheckpoint, private readonly inspect:(path:string)=>Promise<Stats>=lstat, incremental=false) {
    const valid=previous && previous.version === 1 && previous.root === root && previous.catalog && typeof previous.catalog === 'object';
    this.priorPaths=new Set(valid&&previous?Object.keys(previous.catalog):[]);
    this.state = valid ? incremental?{...structuredClone({...previous,catalog:undefined}),catalog:previous.catalog}:clone(previous) : {
      version: 1, identityVersion: 1, root, scanNumber: 0, scanStartedAt: new Date(0).toISOString(), initialized: false,
      inProgress: false, pendingDirectories: [], catalog: {},
    };
    if(incremental){
      this.baseCatalog=this.state.catalog;
      const lookup=(key:string)=>this.changes.has(key)?this.changes.get(key):this.baseCatalog[key];
      this.state.catalog=new Proxy({} as Record<string,FileCatalogEntry>,{
        get:(_target,key)=>typeof key==='string'?lookup(key):undefined,
        set:(_target,key,value)=>{this.changes.set(String(key),value);return true;},
        deleteProperty:(_target,key)=>{this.changes.set(String(key),undefined);return true;},
        ownKeys:()=>[...new Set([...Object.keys(this.baseCatalog),...this.changes.keys()])].filter(key=>lookup(key)!==undefined),
        getOwnPropertyDescriptor:(_target,key)=>typeof key==='string'&&lookup(key)!==undefined?{enumerable:true,configurable:true,writable:true,value:lookup(key)}:undefined,
      });
    }
  }

  checkpoint(incremental=false): LocalFileCheckpoint { return incremental?{...structuredClone({...this.state,catalog:undefined}),catalog:{}}:clone(this.state); }
  catalogChanges():{key:string;value?:FileCatalogEntry}[]{return [...this.changes].filter(([key,value])=>value!==this.baseCatalog[key]).map(([key,value])=>({key,value}));}
  restore(checkpoint: LocalFileCheckpoint): void { this.state = clone(checkpoint); this.listing=undefined; this.rootChecked=false; this.rootFailed=false; this.rootIdentityChanged=false; this.rootChangedMidScan=false; this.observedRootIdentity=undefined; this.reconciled=false; }
  get catalog(): Readonly<Record<string, FileCatalogEntry>> { return this.state.catalog; }

  /** Bind a location only after the scanner has checked its identity. */
  bind(relativePath: string, entryId: string, identityRoot: string, previous?: FileCatalogEntry): void {
    const current=this.state.catalog[relativePath];
    if(!current) throw Error('File candidate was not observed');
    if(previous && previous.relativePath!==relativePath && this.state.catalog[previous.relativePath]?.entryId===previous.entryId) {
      this.remember(previous.relativePath);
      delete this.state.catalog[previous.relativePath];
    }
    this.remember(relativePath);
    this.state.catalog[relativePath]={
      relativePath, fileId:current.fileId, birthtimeMs:current.birthtimeMs, size:current.size,
      mtimeMs:current.mtimeMs, ctimeMs:current.ctimeMs, quickHash:current.quickHash,
      lastSeenScan:current.lastSeenScan, entryId, identityRoot, syncState:previous?.syncState??'pending',
      ...(previous?.contentQuickHash?{contentQuickHash:previous.contentQuickHash}:{}),
      ...(previous?.contentVersion?{contentVersion:previous.contentVersion}:{}),
      ...(previous?.contentHash?{contentHash:previous.contentHash}:{}),
    };
  }

  setVolumeIdentity(value: string | undefined): void { this.state.volumeIdentity=value; }
  setIdentityScope(value: string, volume: string | undefined): void { this.state.identityScope=value;this.state.identityScopeVolume=volume; }
  setIdentityVerificationPending(value: boolean): void { this.state.identityVerificationPending=value; }

  /** A failed read must not pair an old logical ID with unverified metadata. */
  reject(relativePath: string, previous: FileCatalogEntry | undefined): void {
    this.remember(relativePath);
    if(previous)this.state.catalog[relativePath]={...previous,syncState:'error'};
    else delete this.state.catalog[relativePath];
    this.fault('scan_incomplete');
  }

  observe(candidate: DirectoryCandidate): void {
    this.begin();
    this.remember(candidate.relativePath);
    const previous=this.state.catalog[candidate.relativePath];
    const same=previous?.fileId===candidate.fileId && previous.birthtimeMs===candidate.birthtimeMs;
    this.state.catalog[candidate.relativePath] = {
      ...(same?previous:{}), relativePath: candidate.relativePath, fileId: candidate.fileId,
      birthtimeMs: candidate.birthtimeMs, size: candidate.size, mtimeMs: candidate.mtimeMs, ctimeMs: candidate.ctimeMs,
      quickHash: candidate.quickHash, lastSeenScan: this.state.scanNumber,
      syncState: same?previous.syncState:'pending',
    };
  }

  begin(): void {
    if (this.state.inProgress) return;
    this.listing=undefined;
    this.rootChecked=false;
    this.rootFailed=false;
    this.rootIdentityChanged=false;
    this.rootChangedMidScan=false;
    this.observedRootIdentity=undefined;
    this.reconciled=false;
    const now=new Date().toISOString();
    this.state = {
      ...this.state,
      scanNumber: this.state.scanNumber + 1,
      scanStartedAt: now,
      lastScanAttemptAt: now,
      inProgress: true,
      scanFaulted: false,
      lastScanComplete: false,
      degradedReason: undefined,
      pendingDirectories: [this.root],
      activeDirectory: undefined,
      nextFile: undefined,
    };
  }

  /** Verify a readable directory root before any entry is trusted as absent. */
  async verifyRoot(force=false): Promise<boolean> {
    if (force) this.rootChecked=false;
    if (!this.rootChecked) await this.ensureRoot();
    return !this.rootFailed;
  }

  private async ensureRoot(): Promise<void> {
    this.rootChecked=true;
    let info: Stats;
    try { info=await this.inspect(this.root); }
    catch(error) { this.fault((error as NodeJS.ErrnoException)?.code==='EACCES'||(error as NodeJS.ErrnoException)?.code==='EPERM'?'permission_denied':'root_unavailable', true); return; }
    if (info.isSymbolicLink() || !info.isDirectory()) { this.fault('root_changed', true); return; }
    const identity=identityOf(info),previous=this.observedRootIdentity;
    this.observedRootIdentity=identity;
    // A second check during the same scan catches a remount after enumeration.
    if (previous && previous!==identity) { this.rootChangedMidScan=true; this.rootIdentityChanged=true; this.state.degradedReason='root_changed'; }
    if (!this.state.rootIdentity) {
      // Record the first readable identity early so a resumed page can detect
      // that the root changed between shards. It is not deletion permission.
      this.state.rootIdentity=identity;
      if (this.state.initialized && this.priorPaths.size>0) { this.rootIdentityChanged=true; this.state.degradedReason='root_changed'; }
    } else if (this.state.rootIdentity!==identity) {
      this.rootIdentityChanged=true;
      this.state.degradedReason='root_changed';
    }
  }

  private fault(reason: FileScanDegraded, root=false): void {
    this.state.scanFaulted=true;
    this.state.lastScanComplete=false;
    this.state.lastScanAttemptAt=new Date().toISOString();
    if (!this.state.degradedReason || severity[reason] > severity[this.state.degradedReason]) this.state.degradedReason=reason;
    this.reconciled=false;
    if (root) { this.rootChecked=false; this.rootFailed=true; }
  }

  async next(limit: number, excludedPaths: readonly string[]): Promise<{ candidates: DirectoryCandidate[]; complete: boolean; faulted: boolean; skipped: number; degraded?: FileScanDegraded }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Directory catalog batch limit is invalid');
    this.begin();
    if (!this.rootChecked) await this.ensureRoot();
    if (this.rootFailed) return { candidates: [], complete: false, faulted: true, skipped: 0, ...(this.state.degradedReason ? { degraded: this.state.degradedReason } : {}) };
    const candidates: DirectoryCandidate[] = [];
    let skipped = 0;
    let complete = true; let faulted = Boolean(this.state.scanFaulted);
    const isExcluded = (relativePath: string) => relativePath.split('/').some(part => part.startsWith('.')) || excludedPaths.some(value => relativePath === value || relativePath.startsWith(value + '/'));
    while (candidates.length < limit && (this.state.activeDirectory || this.state.pendingDirectories.length)) {
      if (!this.state.activeDirectory) this.state.activeDirectory = { path: this.state.pendingDirectories.shift()! };
      const active = this.state.activeDirectory;
      let listing: NonNullable<DirectoryCatalog['listing']>;
      try {
        if(this.listing?.path!==active.path){
          const entries=(await readdir(active.path)).sort();
          // Durable recovery is name based; the position belongs only to this listing.
          let low=0,high=entries.length;
          if(active.after)while(low<high){const middle=low+Math.floor((high-low)/2);if(entries[middle]<=active.after)low=middle+1;else high=middle;}
          this.listing={path:active.path,entries,position:low};
        }
        listing=this.listing;
      }
      catch (error) { complete = false; faulted = true; this.fault(fileFault(error)); this.state.activeDirectory = undefined; continue; }
      if (listing.position >= listing.entries.length) { this.state.activeDirectory = undefined; continue; }
      // Bound metadata I/O while preserving the lexicographic commit cursor. A
      // failed stat belongs to this scan epoch even if a later shard succeeds.
      while(listing.position<listing.entries.length&&candidates.length<limit){
        const names=listing.entries.slice(listing.position,listing.position+Math.min(4,limit-candidates.length));
        const inspected=await Promise.all(names.map(async name=>{
          const path=join(active.path,name),relativePath=relative(this.root,path).split('\\').join('/');
          if(isExcluded(relativePath))return {name,path,relativePath,excluded:true,info:undefined};
          try{return {name,path,relativePath,excluded:false,info:await this.inspect(path)};}
          catch{return {name,path,relativePath,excluded:false,info:undefined};}
        }));
        for(const {name,path,relativePath,excluded,info} of inspected){
          active.after=name;listing.position++;
          if(excluded){skipped++;continue;}
          if(!info){complete=false;faulted=true;this.fault('scan_incomplete');skipped++;continue;}
          if(info.isSymbolicLink()){skipped++;continue;}
          if(info.isDirectory()){this.state.pendingDirectories.push(path);continue;}
          if(!info.isFile()){skipped++;continue;}
          const fileId=`${info.dev}:${info.ino}`,fingerprint=quickHash(fileId,info.size,info.mtimeMs,info.ctimeMs);
          candidates.push({path,relativePath,fileId,birthtimeMs:info.birthtimeMs,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,quickHash:fingerprint,nlink:info.nlink});
          this.remember(relativePath);
          const previous=this.state.catalog[relativePath],same=previous?.fileId===fileId && previous.birthtimeMs===info.birthtimeMs;
          this.state.catalog[relativePath]={...(same?previous:{}),relativePath,fileId,size:info.size,birthtimeMs:info.birthtimeMs,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,quickHash:fingerprint,lastSeenScan:this.state.scanNumber,syncState:same?previous.syncState:'pending'};
          this.state.nextFile=relativePath;
        }
      }
    }
    if (!this.state.activeDirectory && !this.state.pendingDirectories.length) this.state.inProgress = false;
    return { candidates, complete: complete && !this.state.inProgress && !this.state.scanFaulted, faulted, skipped, ...(this.state.degradedReason ? { degraded: this.state.degradedReason } : {}) };
  }

  markContent(relativePath: string, contentVersion: string | undefined, syncState: FileCatalogEntry['syncState'] = 'synced', contentHash?: string): void {
    const entry = this.state.catalog[relativePath];
    if (!entry) return;
    this.remember(relativePath);
    if (syncState === 'error') this.fault('scan_incomplete');
    this.state.catalog[relativePath] = { ...entry, ...(contentVersion ? { contentVersion, contentQuickHash: entry.quickHash, contentHash } : {}), syncState };
  }

  finishSingle(withholdRemovals=false): void { this.state.inProgress = false; this.state.pendingDirectories = []; this.finishReconciliation(withholdRemovals); }

  finishReconciliation(withholdRemovals=false): string[] {
    const removed: string[] = [];
    this.reconciled=false;
    if (this.state.inProgress || this.state.scanFaulted) return removed;
    // A different device/inode may be a remount of the same share. Adopt it only
    // after a complete scan still sees previously catalogued files; an empty
    // mount shell must never turn every known file into a deletion.
    if (this.rootIdentityChanged) {
      // Enumeration happened under the previous identity, so the current root
      // has never been checked for known files. Keep the old identity and let a
      // fresh scan verify the new root before any absence can be published.
      if (this.rootChangedMidScan) { this.fault('root_changed'); return removed; }
      const knownSeen=[...this.priorPaths].filter(path=>this.state.catalog[path]?.lastSeenScan===this.state.scanNumber).length;
      if (this.priorPaths.size>0 && knownSeen===0) { this.fault('root_changed'); return removed; }
      if (this.observedRootIdentity) this.state.rootIdentity=this.observedRootIdentity;
      this.state.initialized=true;
      this.state.lastScanComplete=true;
      this.state.lastCompleteScanAt=new Date().toISOString();
      // Deletions resume only after one accepted verification generation.
      this.state.degradedReason='root_changed';
      return removed;
    }
    if (!this.state.rootIdentity && this.observedRootIdentity) this.state.rootIdentity=this.observedRootIdentity;
    this.state.initialized = true;
    this.state.lastScanComplete = true;
    this.state.lastCompleteScanAt = new Date().toISOString();
    if(withholdRemovals){this.state.degradedReason='root_changed';return removed;}
    this.state.degradedReason = undefined;
    this.reconciled = true;
    for (const [relativePath, entry] of Object.entries(this.state.catalog)) {
      if (entry.lastSeenScan !== this.state.scanNumber) { removed.push(relativePath); delete this.state.catalog[relativePath]; }
    }
    return removed;
  }
}
