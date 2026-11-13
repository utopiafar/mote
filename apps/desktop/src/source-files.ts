import {sourceWork} from './background';
import type {OriginalSpool} from './original-spool';
import {fileDigest,fileMime} from './file-index';
import { DirectoryCatalog, degradedFileCheckpoint, type DirectoryCandidate } from './directory-catalog';
import { moteText } from '@mote/shared/i18n';
import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath,rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { FileCatalogEntry, FileScanDegraded, LocalFileCheckpoint, SourceOptions, SourceScan } from './source-types';
import { redactSourceText } from './source-types';
import { FileAccessMarkers } from './source-atime';
import { sourceHash } from './source-sync';
import { localVolumeIdentity } from './local-volume';
export async function scanSourceFiles(selectedPath: string, options: SourceOptions, signal?: AbortSignal, accessMarkerPath?: string, previous?: LocalFileCheckpoint, priorityPaths: readonly string[] = [], incrementalCheckpoint=false, recoveryIds: readonly string[] = []): Promise<SourceScan> {
  const accessMarkers = new FileAccessMarkers(accessMarkerPath); await accessMarkers.initialize();
  if(previous && (previous.version!==1 || previous.identityVersion!==1))throw Error('Unsupported local file identity registry; existing source state was preserved');
  const prior=previous&&previous.version===1&&typeof previous.root==='string'&&previous.catalog&&typeof previous.catalog==='object'?previous:undefined;
  const degraded=(reason:FileScanDegraded,checkpoint:LocalFileCheckpoint):SourceScan=>({items:[],seen:[],complete:false,skipped:0,checkpoint:incrementalCheckpoint?{...checkpoint,catalog:{}}:checkpoint,...(incrementalCheckpoint?{catalogChanges:[]}:{}),degraded:reason});
  let selected: Stats;
  try { selected = await lstat(selectedPath); }
  catch(error) {
    if(!prior)throw error;
    const code=(error as NodeJS.ErrnoException)?.code, reason:FileScanDegraded=code==='EACCES'||code==='EPERM'?'permission_denied':'root_unavailable';
    return degraded(reason,degradedFileCheckpoint(prior,reason));
  }
  if (selected.isSymbolicLink() || (!selected.isFile() && !selected.isDirectory())) throw new Error(moteText("所选来源必须是普通文件或目录，不能是符号链接"));
  let root: string;
  try { root = await realpath(selectedPath); }
  catch(error) {
    if(!prior)throw error;
    const code=(error as NodeJS.ErrnoException)?.code, reason:FileScanDegraded=code==='EACCES'||code==='EPERM'?'permission_denied':'root_unavailable';
    return degraded(reason,degradedFileCheckpoint(prior,reason));
  }
  if(prior&&prior.root!==root)return degraded('root_changed',degradedFileCheckpoint(prior,'root_changed'));
  const volumeIdentity=await localVolumeIdentity(root);
  const rootIdentity=`${selected.dev}:${selected.ino}`;
  // An unknown volume returning after an outage may reuse both device and inode
  // numbers. Give that observation a fresh scope; no content digest can prove
  // that it is the formerly authorized root.
  const unverifiedReturn=Boolean(prior?.degradedReason==='root_unavailable' && (!prior.volumeIdentity || !volumeIdentity || prior.volumeIdentity!==volumeIdentity));
  const scopeVolume=prior?.identityScopeVolume??prior?.volumeIdentity;
  const changedVolume=Boolean(prior && volumeIdentity && scopeVolume!==volumeIdentity);
  const verifyIdentity=unverifiedReturn || changedVolume || Boolean(prior?.identityVerificationPending);
  // Only the verified local APFS volume can use its metadata as a fast path.
  // A faulted/offline root must be reconciled even if it comes back unchanged.
  const verifyContent=Boolean(prior?.contentVerificationPending || prior?.degradedReason);
  const trustedMetadata=Boolean(volumeIdentity && prior?.volumeIdentity===volumeIdentity && !verifyContent && !verifyIdentity);
  const identityRoot=!unverifiedReturn && !changedVolume && prior?.identityScope?.startsWith(rootIdentity+':')?prior.identityScope:`${rootIdentity}:${randomUUID()}`;
  const byFileId=new Map<string,FileCatalogEntry[]>();
  for(const entry of Object.values(prior?.catalog??{}))if(entry.entryId){const values=byFileId.get(entry.fileId)??[];values.push(entry);byFileId.set(entry.fileId,values);}
  const claimed=new Map<string,string>();
  // Restart a faulted page rather than carrying its old-root cursor into the
  // newly scoped observation. The complete reconciliation still gates removal.
  const catalogPrevious=unverifiedReturn && previous?.inProgress?{...previous,inProgress:false}:previous;
  const catalog = new DirectoryCatalog(root, catalogPrevious, undefined, incrementalCheckpoint);
  catalog.setIdentityScope(identityRoot,volumeIdentity??scopeVolume);
  catalog.setIdentityVerificationPending(verifyIdentity);
  catalog.setContentVerificationPending(verifyContent);
  catalog?.begin();
  const result: SourceScan = { items: [], seen: [], complete: true, skipped: 0, checkedPriorityPaths: [], ...(catalog ? { checkpoint: catalog.checkpoint(incrementalCheckpoint) } : {}) };
  const priority = [...new Set(priorityPaths)].map(original=>({original,path:isAbsolute(original)?resolve(original):resolve(selected.isDirectory()?root:dirname(root),original)}));
  const signalled=(path:string)=>priority.some(value=>{const child=relative(value.path,path);return !child || child!=='..' && !child.startsWith('..'+sep) && !isAbsolute(child);});
  const handled=new Map<string,string>();
  const candidateSignature=(candidate:DirectoryCandidate)=>`${candidate.fileId}:${candidate.birthtimeMs}:${candidate.quickHash}`;
  let totalBytes = 0;
  const candidateForPath = async (path: string): Promise<DirectoryCandidate | undefined> => {
    if (!catalog) return undefined;
    const absolute = isAbsolute(path) ? path : path;
    const rel = relative(root, absolute).split('\\').join('/');
    if (!rel || rel === '..' || rel.startsWith('../') || rel.split('/').some(part => part.startsWith('.')) || options.excludedPaths.some(value => rel === value || rel.startsWith(value + '/'))) return undefined;
    try {
      const info = await lstat(absolute); if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) return undefined;
      const fileId = `${info.dev}:${info.ino}`, quickHash = sourceHash(`${fileId}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
      const candidate: DirectoryCandidate = { path: absolute, relativePath: rel, fileId, birthtimeMs: info.birthtimeMs, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, quickHash, nlink:info.nlink };
      catalog.observe(candidate); return candidate;
    } catch { return undefined; }
  };
  const processFile = async (candidate: DirectoryCandidate, prior: FileCatalogEntry | undefined, reRead=false): Promise<'ok'|'stop'> => {
    signal?.throwIfAborted();
    const extension = extname(candidate.path).toLowerCase();
    if (!options.extensions.includes(extension)) { result.skipped++; return 'ok'; }
    const sameObject=(entry:FileCatalogEntry)=>Boolean(entry.entryId && entry.identityRoot===identityRoot && entry.fileId===candidate.fileId && entry.birthtimeMs===candidate.birthtimeMs && candidate.birthtimeMs>0 && (!claimed.has(entry.entryId)||claimed.get(entry.entryId)===candidate.relativePath));
    // Never carry an ID into a different root or a different verified volume.
    let rootStillSame=false;
    try { const now=await lstat(root);rootStillSame=!now.isSymbolicLink() && `${now.dev}:${now.ino}`===rootIdentity; } catch { /* unavailable */ }
    const volumeConsistent=!(previous?.volumeIdentity && volumeIdentity && previous.volumeIdentity!==volumeIdentity);
    let matched=rootStillSame && prior && sameObject(prior)?prior:undefined;
    if(!matched && rootStillSame && volumeConsistent && selected.isDirectory() && previous?.rootIdentity===rootIdentity && volumeIdentity && previous.volumeIdentity===volumeIdentity && candidate.fileId.startsWith(`${selected.dev}:`) && candidate.nlink===1) {
      const matches=(byFileId.get(candidate.fileId)??[]).filter(sameObject);
      if(matches.length===1 && matches[0].relativePath!==candidate.relativePath){
        // An extant old link is a distinct location, not a rename.
        try {
          const oldPath=join(root,matches[0].relativePath),oldRelative=relative(root,oldPath);
          if(oldRelative && oldRelative!=='..' && !oldRelative.startsWith('../') && !isAbsolute(oldRelative) && await realpath(oldPath)===oldPath){
            const old=await lstat(oldPath);if(old.dev!==selected.dev || `${old.dev}:${old.ino}`!==candidate.fileId || old.birthtimeMs!==candidate.birthtimeMs)matched=matches[0];
          }
        }
        catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')matched=matches[0];}
      }
    }
    const externalId = matched?.entryId ?? 'file:' + randomUUID();
    const bind=()=>{catalog.bind(candidate.relativePath,externalId,identityRoot,matched);claimed.set(externalId,candidate.relativePath);result.seen.push(externalId);};
    const maximumFile=accessMarkerPath?512*1024*1024:16*1024*1024;
    if (options.retention !== 'reference' && candidate.size > maximumFile) { bind();result.skipped++; return 'ok'; }
    if (result.items.length >= 2000 || options.retention !== 'reference' && totalBytes>0 && totalBytes + candidate.size > 16 * 1024 * 1024) return 'stop';
    const unchanged = matched && matched.relativePath===candidate.relativePath && matched.syncState === 'synced' && matched.contentQuickHash === candidate.quickHash && matched.fileId === candidate.fileId && matched.size === candidate.size && matched.mtimeMs === candidate.mtimeMs && matched.ctimeMs === candidate.ctimeMs && matched.quickHash === candidate.quickHash && matched.contentVersion;
    const mime=fileMime(candidate.path);
    const canReadBody=options.retention!=='reference' && !(options.retention==='snapshot' && options.redactLiterals.length>0 && !mime.startsWith('text/'));
    // A selected local root can itself contain a mounted network filesystem;
    // its files do not inherit the root volume's metadata guarantees.
    const candidateOnTrustedVolume=trustedMetadata && candidate.fileId.startsWith(`${selected.dev}:`);
    if (!reRead && matched && unchanged && (!canReadBody || candidateOnTrustedVolume && !signalled(candidate.path))) { bind();accessMarkers.retain(externalId);catalog.markContent(candidate.relativePath, matched.contentVersion, 'synced',matched.contentHash); return 'ok'; }
    const baseline=options.initialSync === 'new_only' && !previous?.initialized;
    if (baseline && !canReadBody) { bind();catalog.markContent(candidate.relativePath, candidate.quickHash, 'synced'); return 'ok'; }
    let handle;let spooled:OriginalSpool|undefined;
    try {
      // Reconciliation validates the path before and after reading. It never follows a replaced symlink.
      if (await realpath(candidate.path) !== candidate.path) throw new Error('changed path');
      handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || options.retention !== 'reference' && before.size > maximumFile || before.ino !== Number(candidate.fileId.split(':').at(-1)) || before.dev !== Number(candidate.fileId.split(':')[0]) || before.birthtimeMs!==candidate.birthtimeMs || before.size!==candidate.size || before.mtimeMs!==candidate.mtimeMs || before.ctimeMs!==candidate.ctimeMs) throw new Error('changed file');
      // A watcher event can arrive between two writes. Give very recent files
      // a short quiet window, then verify metadata again before reading bytes.
      if (Date.now() - before.mtimeMs < 500) {
        await delay(50, undefined, { signal });
        const stable = await handle.stat();
        if (stable.mtimeMs !== before.mtimeMs || stable.ctimeMs !== before.ctimeMs || stable.size !== before.size) throw new Error('file is still changing');
      }
      let original: Buffer | undefined; let inputState: {parser:string;status:'ready'|'pending'|'blocked';warnings?:string[]} = { parser: 'none', status: 'ready' };
      if(options.retention==='snapshot'&&options.redactLiterals.length&&!mime.startsWith('text/')){
        inputState={parser:'privacy-blocked',status:'blocked',warnings:['Source literal masks cannot be safely applied to this format; input was not uploaded.']};
      }else if(options.retention!=='reference'){
        if(options.retention==='snapshot'&&options.redactLiterals.length){
          const buffer=Buffer.alloc(before.size+1),read=await handle.read(buffer,0,buffer.length,0);if(read.bytesRead!==before.size)throw Error('changed file');
          const decoded=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,read.bytesRead));if(decoded.includes('\0'))throw Error('Invalid UTF-8 text');
          original=Buffer.from(redactSourceText(decoded,options.redactLiterals));
          if(accessMarkerPath){spooled=await sourceWork.run<OriginalSpool>({kind:'spool-bytes',bytes:original,directory:accessMarkerPath+'.index-inputs'});original=undefined;signal?.throwIfAborted();}
        }else if(accessMarkerPath){
          spooled=await sourceWork.run<OriginalSpool>({kind:'spool-original',path:candidate.path,directory:accessMarkerPath+(options.retention==='snapshot'?'.index-inputs':'.originals'),expected:{dev:before.dev,ino:before.ino,size:before.size,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs}});signal?.throwIfAborted();
        }else{const buffer=Buffer.alloc(before.size+1),read=await handle.read(buffer,0,buffer.length,0);if(read.bytesRead!==before.size)throw Error('changed file');original=buffer.subarray(0,read.bytesRead);}
        inputState={parser:'central-pending',status:'pending'};
      }
      const after = await handle.stat();
      const pathAfter=await lstat(candidate.path);
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev!==after.dev || pathAfter.ino!==after.ino || pathAfter.size!==after.size || pathAfter.mtimeMs!==after.mtimeMs || pathAfter.ctimeMs!==after.ctimeMs || await realpath(candidate.path) !== candidate.path) throw new Error('changed file');
      const rootAfter=await lstat(root);if(rootAfter.isSymbolicLink()||`${rootAfter.dev}:${rootAfter.ino}`!==rootIdentity)throw new Error('changed root');
      totalBytes += before.size;
      const accessedAtMs = accessMarkers.record(externalId, before, after), fileMetadata = observedFileMetadata(before, accessedAtMs);
      const contentHash = spooled?.sha256??(original ? fileDigest(original) : undefined),contentVersion=contentHash??candidate.quickHash;
      // The digest is always of the exact bytes destined for Central, including
      // literal masking. Never compare a raw original to a transformed digest.
      if (baseline || matched && unchanged && contentHash && contentHash===matched.contentHash) {
        bind();catalog.markContent(candidate.relativePath, contentVersion, 'synced',contentHash);
        if(spooled){await rm(spooled.directory,{force:true,recursive:true});spooled=undefined;}
        return 'ok';
      }
      result.items.push({ externalId, title: redactSourceText(basename(candidate.path), options.redactLiterals), text: '', uri: options.redactLiterals.length ? undefined : pathToFileURL(candidate.path).href, modifiedAt: before.mtime.toISOString(), kind: 'file', layer: options.retention === 'archive' ? 'original' : options.retention, document: { fileIndex: { version: 1, fileId: externalId, contentVersion, mode: options.retention === 'archive' ? 'archive' : options.retention === 'reference' ? 'catalog' : 'index', coverage: 'none', parser: inputState.parser, ...(inputState.warnings?.length?{warnings:inputState.warnings.map(warning=>redactSourceText(warning,options.redactLiterals))}:{}), status: options.retention === 'archive' ? 'pending' : inputState.status, totalCharacters: 0, offset: 0, length: 0, ...(options.retention==='snapshot'?{maxIndexCharacters:100000}:{}), allowRead: options.retention === 'snapshot' && Boolean(options.allowRead) } }, ...(spooled && options.retention !== 'reference'?{localOriginal:spooled}:{}), ...(options.retention !== 'reference' && original ? { localOriginalBase64: original.toString('base64') } : {}), metadata: { version: 1, file: fileMetadata }, mimeType: fileMime(candidate.path), deleted: false });
      bind();catalog.markContent(candidate.relativePath, contentVersion, 'synced',contentHash);
      return 'ok';
    } catch { if(spooled)await rm(spooled.directory,{force:true,recursive:true});result.skipped++; result.complete = false; catalog.reject(candidate.relativePath,prior); return 'ok'; }
    finally { await handle?.close(); }
  };
  const recovery = recoveryIds.length ? new Set(recoveryIds) : undefined;
  if (recovery) {
    // Re-read only the identities Central explicitly asked to resupply. This is
    // not re-enumeration or reconciliation: no other file, new content or
    // absence is observed, so a one-time import keeps its frozen scope.
    if (selected.isDirectory() && catalog) {
      if (await catalog.verifyRoot()) {
        for (const entry of Object.values(prior?.catalog ?? {})) {
          if (!entry.entryId || !recovery.has(entry.entryId)) continue;
          catalog.savepoint();
          const candidate = await candidateForPath(join(root, entry.relativePath));
          if (!candidate) { catalog.rollbackSavepoint(); result.skipped++; continue; }
          const outcome = await processFile(candidate, catalog.previous(candidate.relativePath), true);
          if (outcome === 'stop') { catalog.rollbackSavepoint(); result.skipped++; break; }
        }
      } else { result.complete = false; result.degraded = catalog.degraded; }
    } else {
      const fileId = `${selected.dev}:${selected.ino}`, candidate: DirectoryCandidate = { path: root, relativePath: basename(root), fileId, birthtimeMs: selected.birthtimeMs, size: selected.size, mtimeMs: selected.mtimeMs, ctimeMs: selected.ctimeMs, quickHash: sourceHash(`${fileId}:${selected.size}:${selected.mtimeMs}:${selected.ctimeMs}`), nlink: selected.nlink };
      catalog.savepoint(); catalog.observe(candidate);
      const entry = catalog.previous(basename(root));
      if (!entry?.entryId || !recovery.has(entry.entryId)) { catalog.rollbackSavepoint(); result.skipped++; }
      else await processFile(candidate, entry, true);
    }
    // A targeted re-read never proves what else exists or changed.
    result.complete = false;
    result.checkpoint = undefined;
    await accessMarkers.persist(result.complete);
    return result;
  }
  if (selected.isDirectory() && catalog) {
    let examined = 0;
    // A root that cannot be read, or whose device/inode changed, is checked
    // before any path is treated as absent. Priority paths wait for that check.
    if (await catalog.verifyRoot()) {
      for (const {original,path} of priority) {
        if (examined >= 2000) break;
        catalog.savepoint(); const candidate = await candidateForPath(path); if (!candidate) continue;
        const outcome = await processFile(candidate, catalog.previous(candidate.relativePath)); examined++;
        if (outcome === 'stop') { catalog.rollbackSavepoint(); result.complete = false; break; }
        handled.set(candidate.relativePath,candidateSignature(candidate));result.checkedPriorityPaths!.push(original);
      }
    } else { result.complete = false; result.degraded = catalog.degraded; }
    while (examined < 2000 && result.complete) {
      catalog.savepoint(); const batch = await catalog.next(Math.min(options.retention !== 'reference' ? 1 : 256, 2000 - examined, 2000 - result.items.length), options.excludedPaths);
      if (batch.degraded) result.degraded = batch.degraded;
      if (!batch.candidates.length) { result.complete = batch.complete; result.skipped += batch.skipped; break; }
      examined += batch.candidates.length;
      const itemsBeforeBatch = result.items.length, seenBeforeBatch = result.seen.length;
      let stopped = false;
      for (const candidate of batch.candidates) {
        // Priority paths can also occur in the regular page. Avoid reading the
        // same observation twice while still noticing a later metadata change.
        if(handled.get(candidate.relativePath)===candidateSignature(candidate))continue;
        const outcome = await processFile(candidate, catalog.previous(candidate.relativePath));
        if (outcome === 'stop') { stopped = true; break; }
      }
      if (stopped) { catalog.rollbackSavepoint(); result.items.splice(itemsBeforeBatch); result.seen.splice(seenBeforeBatch); result.complete = false; break; }
      result.skipped += batch.skipped;
      if (batch.faulted) result.complete = false;
      if (result.items.length >= 2000 || totalBytes >= 16 * 1024 * 1024) { result.complete = false; break; }
      if (!catalog.inProgress) break;
      if (examined >= 2000) { result.complete = false; break; }
    }
    if (result.complete && !catalog.inProgress) {
      // A remount can replace the root while enumeration is running.
      if (!await catalog.verifyRoot(true)) { result.complete=false; result.degraded=catalog.degraded; }
      else catalog.finishReconciliation(verifyIdentity);
      if (result.complete && catalog.lastReconciliationComplete) {
        // A complete shard must reconcile against every file in the catalog,
        // not only the final batch returned by this invocation.
        result.seen = Object.values(catalog.catalog).filter(entry => entry.entryId && options.extensions.includes(extname(entry.relativePath).toLowerCase())).map(entry => entry.entryId!);
      } else {
        // A verified root generation must complete once before removals resume.
        result.complete = false;
        result.degraded = catalog.degraded ?? 'root_changed';
      }
    }
    if (!result.complete && catalog.degraded) result.degraded = catalog.degraded;
    if(verifyIdentity && result.complete){result.complete=false;result.degraded='root_changed';}
    if(catalog.checkpoint(true).lastScanComplete){catalog.setVolumeIdentity(volumeIdentity);catalog.setContentVerificationPending(false);if(verifyIdentity)catalog.setIdentityVerificationPending(false);}
    result.checkpoint = catalog.checkpoint(incrementalCheckpoint);
    if(incrementalCheckpoint)result.catalogChanges=catalog.catalogChanges();
  } else {
    const fileId = `${selected.dev}:${selected.ino}`, candidate: DirectoryCandidate = { path: root, relativePath: basename(root), fileId, birthtimeMs: selected.birthtimeMs, size: selected.size, mtimeMs: selected.mtimeMs, ctimeMs: selected.ctimeMs, quickHash: sourceHash(`${fileId}:${selected.size}:${selected.mtimeMs}:${selected.ctimeMs}`),nlink:selected.nlink };
    catalog.savepoint(); catalog.observe(candidate);
    await processFile(candidate, catalog.previous(candidate.relativePath));
    result.checkedPriorityPaths!.push(...priority.filter(value=>value.path===root).map(value=>value.original));
    if (result.complete) {catalog.finishSingle(verifyIdentity);catalog.setVolumeIdentity(volumeIdentity);catalog.setContentVerificationPending(false);if(verifyIdentity){catalog.setIdentityVerificationPending(false);result.complete=false;result.degraded='root_changed';}}
    result.checkpoint = catalog.checkpoint(incrementalCheckpoint);
    if (incrementalCheckpoint) result.catalogChanges = catalog.catalogChanges();
  }
  await accessMarkers.persist(result.complete);
  return result;
}

export function observedFileMetadata(before: Stats, accessedAtMs: number): NonNullable<import('@mote/shared').SourceMetadata['file']> {
  const timestamp = (ms: number) => Number.isFinite(ms) && ms > 0 && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined;
  // Node documents ctime/epoch fallbacks when the filesystem cannot provide birth time.
  // Equal birth/ctime is ambiguous even on a supported filesystem, so omit instead of guessing.
  const createdAt = before.birthtimeMs === before.ctimeMs ? undefined : timestamp(before.birthtimeMs);
  const accessedAt = timestamp(accessedAtMs), metadataChangedAt = timestamp(before.ctimeMs);
  return { sizeBytes: before.size, ...(createdAt ? { createdAt } : {}), ...(accessedAt ? { accessedAt } : {}), ...(metadataChangedAt ? { metadataChangedAt } : {}) };
}
