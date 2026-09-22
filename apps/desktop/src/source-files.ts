import {sourceWork} from './background';
import type {OriginalSpool} from './original-spool';
import {fileDigest,fileMime} from './file-index';
import { contentAdapter } from './content-adapter';
import { DirectoryCatalog, type DirectoryCandidate } from './directory-catalog';
import { moteText } from '@mote/shared/i18n';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath,rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { FileCatalogEntry, LocalFileCheckpoint, SourceOptions, SourceScan } from './source-types';
import { redactSourceText } from './source-types';
import { FileAccessMarkers } from './source-atime';
import { sourceHash } from './source-sync';
export async function scanSourceFiles(selectedPath: string, options: SourceOptions, signal?: AbortSignal, accessMarkerPath?: string, locations?: Map<string,string>, previous?: LocalFileCheckpoint, priorityPaths: readonly string[] = []): Promise<SourceScan> {
  const accessMarkers = new FileAccessMarkers(accessMarkerPath); await accessMarkers.initialize();
  const selected = await lstat(selectedPath);
  if (selected.isSymbolicLink() || (!selected.isFile() && !selected.isDirectory())) throw new Error(moteText("所选来源必须是普通文件或目录，不能是符号链接"));
  const root = await realpath(selectedPath);
  const catalog = selected.isDirectory() ? new DirectoryCatalog(root, previous) : undefined;
  catalog?.begin();
  const result: SourceScan = { items: [], seen: [], complete: true, skipped: 0, ...(catalog ? { checkpoint: catalog.checkpoint() } : {}) };
  let totalBytes = 0;
  const candidateForPath = async (path: string): Promise<DirectoryCandidate | undefined> => {
    if (!catalog) return undefined;
    const absolute = isAbsolute(path) ? path : path;
    const rel = relative(root, absolute).split('\\').join('/');
    if (!rel || rel === '..' || rel.startsWith('../') || rel.split('/').some(part => part.startsWith('.')) || options.excludedPaths.some(value => rel === value || rel.startsWith(value + '/'))) return undefined;
    try {
      const info = await lstat(absolute); if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) return undefined;
      const fileId = `${info.dev}:${info.ino}`, quickHash = sourceHash(`${fileId}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
      const candidate: DirectoryCandidate = { path: absolute, relativePath: rel, fileId, birthtimeMs: info.birthtimeMs, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, quickHash };
      catalog.observe(candidate); return candidate;
    } catch { return undefined; }
  };
  const processFile = async (candidate: DirectoryCandidate, prior: FileCatalogEntry | undefined): Promise<'ok'|'stop'> => {
    signal?.throwIfAborted();
    const extension = extname(candidate.path).toLowerCase();
    if (!options.extensions.includes(extension)) { result.skipped++; return 'ok'; }
    const externalId = 'file:' + sourceHash([candidate.fileId, candidate.birthtimeMs].join(':'));
    result.seen.push(externalId); locations?.set(externalId, candidate.path);
    const maximumFile=options.retention==='archive'&&accessMarkerPath?512*1024*1024:16*1024*1024;
    if (options.retention !== 'reference' && candidate.size > maximumFile) { result.skipped++; return 'ok'; }
    if (result.items.length >= 2000 || options.retention !== 'reference' && result.items.length>0 && totalBytes + candidate.size > 16 * 1024 * 1024) return 'stop';
    const unchanged = prior && prior.fileId === candidate.fileId && prior.size === candidate.size && prior.mtimeMs === candidate.mtimeMs && prior.ctimeMs === candidate.ctimeMs && prior.quickHash === candidate.quickHash && prior.contentHash;
    if (unchanged) { catalog?.markContent(candidate.relativePath, prior.contentHash, 'synced'); return 'ok'; }
    if (options.initialSync === 'new_only' && !previous?.initialized) { catalog?.markContent(candidate.relativePath, candidate.quickHash, 'synced'); return 'ok'; }
    let handle;let spooled:OriginalSpool|undefined;
    try {
      // Reconciliation validates the path before and after reading. It never follows a replaced symlink.
      if (await realpath(candidate.path) !== candidate.path) throw new Error('changed path');
      handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || options.retention !== 'reference' && before.size > maximumFile || before.ino !== Number(candidate.fileId.split(':').at(-1)) || before.dev !== Number(candidate.fileId.split(':')[0])) throw new Error('changed file');
      // A watcher event can arrive between two writes. Give very recent files
      // a short quiet window, then verify metadata again before reading bytes.
      if (Date.now() - before.mtimeMs < 500) {
        await delay(50, undefined, { signal });
        const stable = await handle.stat();
        if (stable.mtimeMs !== before.mtimeMs || stable.ctimeMs !== before.ctimeMs || stable.size !== before.size) throw new Error('file is still changing');
      }
      let text = ''; let original: Buffer | undefined; let parsed: import('./content-adapter').ContentReadResult = { text: '', parser: 'none', status: 'ready' as 'ready'|'pending'|'unsupported' };
      if(options.retention==='archive'&&accessMarkerPath){
        spooled=await sourceWork.run<OriginalSpool>({kind:'spool-original',path:candidate.path,directory:accessMarkerPath+'.originals',expected:{dev:before.dev,ino:before.ino,size:before.size,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs}});
        signal?.throwIfAborted();
      } else if (options.retention !== 'reference') {
        const buffer = Buffer.alloc(before.size + 1), read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead !== before.size) throw new Error('changed file');
        original = buffer.subarray(0, read.bytesRead);
        if (options.retention === 'snapshot') parsed = await contentAdapter(fileMime(candidate.path)).read(original, fileMime(candidate.path), signal);
        const maximum = options.indexMode === 'lightweight' ? 8000 : 100000;
        parsed.text = redactSourceText(parsed.text, options.redactLiterals); text = parsed.text.slice(0, maximum);
      }
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || await realpath(candidate.path) !== candidate.path) throw new Error('changed file');
      totalBytes += before.size;
      const accessedAtMs = accessMarkers.record(externalId, before, after), fileMetadata = observedFileMetadata(before, accessedAtMs);
      const contentHash = spooled?.sha256??(original ? fileDigest(original) : candidate.quickHash);
      result.items.push({ externalId, title: redactSourceText(basename(candidate.path), options.redactLiterals), text, uri: options.redactLiterals.length ? undefined : pathToFileURL(candidate.path).href, modifiedAt: before.mtime.toISOString(), kind: 'file', layer: options.retention === 'archive' ? 'original' : options.retention, document: { fileIndex: { version: 1, fileId: externalId, contentVersion: contentHash, mode: options.retention === 'archive' ? 'archive' : options.retention === 'reference' ? 'catalog' : 'index', coverage: !text ? 'none' : text.length === parsed.text.length && parsed.coverage !== 'partial' ? 'full' : 'lightweight', parser: parsed.parser, ...(parsed.warnings?.length?{warnings:parsed.warnings.map(warning=>redactSourceText(warning,options.redactLiterals))}:{}), status: options.retention === 'archive' ? 'pending' : parsed.status, totalCharacters: parsed.text.length, offset: 0, length: text.length, allowRead: options.retention === 'snapshot' && Boolean(options.allowRead) } }, ...(spooled?{localOriginal:spooled}:{}), ...(options.retention === 'archive' && original ? { localOriginalBase64: original.toString('base64') } : {}), metadata: { version: 1, file: fileMetadata }, mimeType: fileMime(candidate.path), deleted: false });
      catalog?.markContent(candidate.relativePath, contentHash, 'synced');
      return 'ok';
    } catch { if(spooled)await rm(spooled.directory,{force:true,recursive:true});result.skipped++; result.complete = false; catalog?.markContent(candidate.relativePath, undefined, 'error'); return 'ok'; }
    finally { await handle?.close(); }
  };
  if (selected.isDirectory() && catalog) {
    let examined = 0;
    const priority = [...new Set(priorityPaths)].map(path => isAbsolute(path) ? path : `${root}/${path}`);
    for (const path of priority) {
      if (examined >= 2000) break;
      catalog.savepoint(); const candidate = await candidateForPath(path); if (!candidate) continue;
      const outcome = await processFile(candidate, catalog.previous(candidate.relativePath)); examined++;
      if (outcome === 'stop') { catalog.rollbackSavepoint(); result.complete = false; break; }
    }
    while (examined < 2000 && result.complete) {
      catalog.savepoint(); const batch = await catalog.next(Math.min(options.retention === 'archive' ? 1 : 256, 2000 - examined, 2000 - result.items.length), options.excludedPaths);
      if (!batch.candidates.length) { result.complete = batch.complete; result.skipped += batch.skipped; break; }
      examined += batch.candidates.length;
      const itemsBeforeBatch = result.items.length, seenBeforeBatch = result.seen.length;
      let stopped = false;
      for (const candidate of batch.candidates) {
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
      catalog.finishReconciliation();
      // A complete shard must reconcile against every file in the catalog,
      // not only the final batch returned by this invocation.
      result.seen = Object.values(catalog.catalog).filter(entry => options.extensions.includes(extname(entry.relativePath).toLowerCase())).map(entry => 'file:' + sourceHash([entry.fileId, entry.birthtimeMs].join(':')));
    }
    result.checkpoint = catalog.checkpoint();
  } else {
    const fileId = `${selected.dev}:${selected.ino}`, candidate: DirectoryCandidate = { path: root, relativePath: basename(root), fileId, birthtimeMs: selected.birthtimeMs, size: selected.size, mtimeMs: selected.mtimeMs, ctimeMs: selected.ctimeMs, quickHash: sourceHash(`${fileId}:${selected.size}:${selected.mtimeMs}:${selected.ctimeMs}`) };
    await processFile(candidate, undefined);
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
