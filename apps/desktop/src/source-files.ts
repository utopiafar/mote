import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourceOptions, SourceScan } from './source-types';
import { redactSourceText } from './source-types';
import { sourceHash } from './source-sync';
export async function scanSourceFiles(selectedPath: string, options: SourceOptions, signal?: AbortSignal): Promise<SourceScan> {
  const selected = await lstat(selectedPath);
  if (selected.isSymbolicLink() || (!selected.isFile() && !selected.isDirectory())) throw new Error('所选来源必须是普通文件或目录，不能是符号链接');
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
    const externalId = 'file:' + sourceHash(resolve(path)); result.seen.push(externalId);
    if (metadata.size > 100000 || result.items.length >= 2000 || totalBytes + metadata.size > 16 * 1024 * 1024) { result.skipped++; if (result.items.length >= 2000 || totalBytes + metadata.size > 16 * 1024 * 1024) result.complete = false; return; }
    let text = ''; let handle;
    try {
      // Verify every traversed directory still resolves inside the chosen tree before opening without following a leaf symlink.
      if (await realpath(path) !== path) throw new Error('changed path');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || before.size > 100000 || before.ino !== metadata.ino || before.dev !== metadata.dev) throw new Error('changed file');
      if (options.retention === 'snapshot') {
        const buffer = Buffer.alloc(100001); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 100000 || bytesRead !== before.size) throw new Error('changed file');
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || await realpath(path) !== path) throw new Error('changed file');
      totalBytes += before.size;
      result.items.push({ externalId, title: redactSourceText(basename(path), options.redactLiterals), text: redactSourceText(text, options.redactLiterals), uri: options.redactLiterals.length ? undefined : pathToFileURL(path).href, modifiedAt: before.mtime.toISOString(), kind: 'file', layer: options.retention, mimeType: 'text/plain', deleted: false });
    } catch { result.skipped++; result.complete = false; }
    finally { await handle?.close(); }
  }
  if (selected.isDirectory()) {
    for (const entry of (await readdir(root)).sort()) { if (visited > 5000) break; await visit(join(root, entry), entry); }
  } else await visit(root, basename(root));
  return result;
}
