import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extractFileText, fileDigest } from './file-index';
import {originalPart,type OriginalIdentity,type OriginalSpool} from './original-spool';
import type { ContentReadResult } from './content-adapter';

/** Transport persists this input contract, never raw snapshot bytes. Host owns retries and publication. */
export interface LocalFileInput { path: string; expected: OriginalIdentity; spool?: OriginalSpool; processor: { id: string; version: number } }
export interface LocalFileResult extends ContentReadResult { contentVersion: string }
export interface LocalFileProcessor {
  id: string; version: number;
  read(bytes: Buffer, mime: string, signal?: AbortSignal): Promise<ContentReadResult>;
}
export class LocalFileProcessors {
  private modules = new Map<string, LocalFileProcessor>();
  register(module: LocalFileProcessor): this {
    const key = `${module.id}:${module.version}`;
    if (!module.id || !Number.isSafeInteger(module.version) || module.version < 1 || this.modules.has(key)) throw Error('Invalid local file processor');
    this.modules.set(key, module); return this;
  }
  get(input: LocalFileInput): LocalFileProcessor {
    const module = this.modules.get(`${input.processor.id}:${input.processor.version}`);
    if (!module) throw Error('Local file processor unavailable');
    return module;
  }
}
export const defaultLocalFileProcessor = { id: 'local-file', version: 1 };
export const localFileProcessors = new LocalFileProcessors().register({ ...defaultLocalFileProcessor, read: extractFileText });
export async function processLocalFile(input: LocalFileInput, mime: string, signal?: AbortSignal, modules = localFileProcessors): Promise<LocalFileResult> {
  signal?.throwIfAborted();
  if (input.spool) {
    if (input.spool.sizeBytes > 16 * 1024 * 1024) throw Error('Local processing input exceeds its limit');
    const parts: Buffer[] = [];
    for (let part = 0; part * input.spool.partBytes < input.spool.sizeBytes; part++) { signal?.throwIfAborted(); parts.push(await originalPart(input.spool,part)); }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== input.spool.sizeBytes || fileDigest(bytes) !== input.spool.sha256) throw Error('Local processing input checksum mismatch');
    const result = await modules.get(input).read(bytes,mime,signal); signal?.throwIfAborted();
    return {...result,contentVersion:input.spool.sha256};
  }
  const matches = (stat: Awaited<ReturnType<typeof lstat>>) => stat.isFile() && !stat.isSymbolicLink() &&
    (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => stat[key] === input.expected[key]);
  if (input.expected.size > 16 * 1024 * 1024 || await realpath(input.path) !== input.path || !matches(await lstat(input.path))) throw Error('Local processing input changed');
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!matches(await handle.stat())) throw Error('Local processing input changed');
    const bytes = await handle.readFile();
    if (!matches(await handle.stat()) || await realpath(input.path) !== input.path || !matches(await lstat(input.path))) throw Error('Local processing input changed');
    const result = await modules.get(input).read(bytes, mime, signal);
    signal?.throwIfAborted();
    return { ...result, contentVersion: fileDigest(bytes) };
  } finally { await handle.close(); }
}
