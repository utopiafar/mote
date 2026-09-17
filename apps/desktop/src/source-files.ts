import {extractFileText,fileDigest,fileMime} from './file-index';
import { moteText } from '@mote/shared/i18n';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourceOptions, SourceScan } from './source-types';
import { redactSourceText } from './source-types';
import { FileAccessMarkers } from './source-atime';
import { sourceHash } from './source-sync';
export async function scanSourceFiles(selectedPath: string, options: SourceOptions, signal?: AbortSignal, accessMarkerPath?: string, locations?: Map<string,string>): Promise<SourceScan> {
  const accessMarkers = new FileAccessMarkers(accessMarkerPath); await accessMarkers.initialize();
  const selected = await lstat(selectedPath);
  if (selected.isSymbolicLink() || (!selected.isFile() && !selected.isDirectory())) throw new Error(moteText("所选来源必须是普通文件或目录，不能是符号链接"));
  const root = await realpath(selectedPath);
  const result: SourceScan = { items: [], seen: [], complete: true, skipped: 0 };
  let visited = 0; let totalBytes = 0;
  async function visit(path: string, relativeName: string): Promise<void> {
    signal?.throwIfAborted();
    if (++visited > 5000) { result.complete = false; result.skipped++; return; }
    if (relativeName.split('/').some(p => p.startsWith('.')) || options.excludedPaths.some(p => relativeName === p || relativeName.startsWith(p + '/'))) { result.skipped++; return; }
    let metadata;
    try { metadata = await lstat(path); } catch { result.complete = false; result.skipped++; return; }
    if (metadata.isSymbolicLink()) { result.skipped++; return; }
    if (metadata.isDirectory()) {
      try { for (const entry of (await readdir(path)).sort()) { if (visited > 5000) break; await visit(join(path, entry), relativeName ? relativeName + '/' + entry : entry); } }
      catch { result.complete = false; result.skipped++; } return;
    }
    if (!metadata.isFile() || !options.extensions.includes(extname(path).toLowerCase())) { result.skipped++; return; }
    const externalId = 'file:' + sourceHash([metadata.dev,metadata.ino,metadata.birthtimeMs].join(':')); result.seen.push(externalId);locations?.set(externalId,path);
    if (options.retention!=='reference' && metadata.size > 16*1024*1024 || result.items.length >= 2000 || options.retention!=='reference' && totalBytes + metadata.size > 16 * 1024 * 1024) { result.skipped++; if (result.items.length >= 2000 || options.retention!=='reference' && totalBytes + metadata.size > 16 * 1024 * 1024) result.complete = false; return; }
    let text = ''; let handle;let original:Buffer|undefined;let parsed={text:'',parser:'none',status:'ready' as 'ready'|'pending'|'unsupported'};
    try {
      // Verify every traversed directory still resolves inside the chosen tree before opening without following a leaf symlink.
      if (await realpath(path) !== path) throw new Error('changed path');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || options.retention!=='reference' && before.size > 16*1024*1024 || before.ino !== metadata.ino || before.dev !== metadata.dev) throw new Error('changed file');
      if (options.retention !== 'reference') {
        const buffer=Buffer.alloc(before.size+1),read=await handle.read(buffer,0,buffer.length,0);if(read.bytesRead!==before.size)throw Error('Changed file');original=buffer.subarray(0,read.bytesRead);
        if(options.retention==='snapshot')parsed=await extractFileText(original,fileMime(path),signal);
        const maximum=options.indexMode==='lightweight'?8000:100000;
        parsed.text=redactSourceText(parsed.text,options.redactLiterals);text=parsed.text.slice(0,maximum);
      }
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || await realpath(path) !== path) throw new Error('changed file');
      totalBytes += before.size;
      const accessedAtMs = accessMarkers.record(externalId, before, after);
      const fileMetadata = observedFileMetadata(before, accessedAtMs);
      result.items.push({ externalId, title: redactSourceText(basename(path), options.redactLiterals), text, uri: options.redactLiterals.length ? undefined : pathToFileURL(path).href, modifiedAt: before.mtime.toISOString(), kind: 'file', layer: options.retention==='archive'?'original':options.retention, document:{fileIndex:{version:1,fileId:externalId,contentVersion:original?fileDigest(original):sourceHash([before.dev,before.ino,before.mtimeMs,before.size].join(':')),mode:options.retention==='archive'?'archive':options.retention==='reference'?'catalog':'index',coverage:!text?'none':text.length===parsed.text.length?'full':'lightweight',parser:parsed.parser,status:options.retention==='archive'?'pending':parsed.status,totalCharacters:parsed.text.length,offset:0,length:text.length,allowRead:options.retention==='snapshot'&&Boolean(options.allowRead)}}, ...(options.retention==='archive'&&original?{localOriginalBase64:original.toString('base64')} : {}), metadata: { version: 1, file: fileMetadata }, mimeType: fileMime(path), deleted: false });
    } catch { result.skipped++; result.complete = false; }
    finally { await handle?.close(); }
  }
  if (selected.isDirectory()) {
    for (const entry of (await readdir(root)).sort()) { if (visited > 5000) break; await visit(join(root, entry), entry); }
  } else await visit(root, basename(root));
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
