import { open } from 'node:fs/promises';
import { posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';
/** Inspect the central directory before ditto can follow archive paths or symlinks. */
export async function inspectUpdateArchive(path: string): Promise<string> {
  const file = await open(path, 'r');
  const invalid = (): never => { throw new Error('UPDATE_ARCHIVE_INVALID'); };
  try {
    const size = (await file.stat()).size; if (size < 22 || size > 2_000_000_000) invalid();
    const tail = Buffer.alloc(Math.min(size, 65557)); await file.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) invalid();
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (!count || count >= 50000 || count !== tail.readUInt16LE(end + 8) || length > 32 * 1024 * 1024 || offset + length > size - tail.length + end) invalid();
    const entries = Buffer.alloc(length); const read = await file.read(entries, 0, length, offset); if (read.bytesRead !== length) invalid();
    let at = 0, uncompressed = 0; const roots = new Set<string>(), seen = new Map<string, boolean>(), links = new Map<string, string>(), spellings = new Map<string, string>();
    // The destination may use case-insensitive, Unicode-normalizing APFS/HFS+.
    const pathKey = (name: string) => name.normalize('NFD').toUpperCase().toLowerCase();
    const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (let entry = 0; entry < count; entry++) {
      if (at + 46 > length || entries.readUInt32LE(at) !== 0x02014b50) invalid();
      const flags = entries.readUInt16LE(at + 8), method = entries.readUInt16LE(at + 10);
      const compressed = entries.readUInt32LE(at + 20), expanded = entries.readUInt32LE(at + 24);
      const names = entries.readUInt16LE(at + 28), extra = entries.readUInt16LE(at + 30), comment = entries.readUInt16LE(at + 32);
      const mode = entries.readUInt32LE(at + 38) >>> 16, type = mode & 0xf000;
      const localOffset = entries.readUInt32LE(at + 42);
      if (flags & 1 || ![0, 8].includes(method) || at + 46 + names + extra + comment > length || ![0, 0x4000, 0x8000, 0xa000].includes(type)) invalid();
      const name = decode(entries.subarray(at + 46, at + 46 + names));
      const parts = name.replace(/\/$/, '').split('/');
      if (!name || name.length > 4096 || /[\\\x00-\x1f\x7f]/.test(name) || parts.some(p => !p || p === '.' || p === '..') || seen.has(pathKey(parts.join('/')))) invalid();
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'), key = pathKey(prefix);
        if (spellings.has(key) && spellings.get(key) !== prefix) invalid();
        spellings.set(key, prefix);
      }
      seen.set(pathKey(parts.join('/')), type === 0x4000 || name.endsWith('/')); const root = parts[0];
      if (root !== '__MACOSX') { if (!root.endsWith('.app')) invalid(); roots.add(root); }
      if (roots.size > 1) invalid();
      uncompressed += expanded; if (uncompressed > 2_000_000_000) invalid();
      if (localOffset + 30 > offset) invalid();
      const header = Buffer.alloc(30); if ((await file.read(header, 0, 30, localOffset)).bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== method) invalid();
      const localNameLength = header.readUInt16LE(26), start = localOffset + 30 + localNameLength + header.readUInt16LE(28);
      if (start + compressed > offset || localNameLength !== names) invalid();
      const localName = Buffer.alloc(localNameLength); if ((await file.read(localName, 0, localNameLength, localOffset + 30)).bytesRead !== localNameLength || decode(localName) !== name) invalid();
      if (type === 0xa000) {
        if (root === '__MACOSX' || name.endsWith('/') || expanded > 4096 || compressed > 8192) invalid();
        const bytes = Buffer.alloc(compressed); if ((await file.read(bytes, 0, compressed, start)).bytesRead !== compressed) invalid();
        const target = decode(method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: 4096 }));
        if (!target || target.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(target)) invalid();
        links.set(pathKey(name), target);
      }
      at += 46 + names + extra + comment;
    }
    if (at !== length || roots.size !== 1) invalid();
    const root = [...roots][0];
    // No entry may be extracted through a symlink or regular file, regardless of ZIP ordering.
    for (const name of seen.keys()) {
      const pieces = name.split('/');
      for (let i = 1; i < pieces.length; i++) if (seen.get(pieces.slice(0, i).join('/')) === false) invalid();
    }
    for (const [name, target] of links) {
      const pending = [...posix.dirname(name).split('/'), ...target.split('/')], resolved: string[] = [];
      let followed = 0;
      // Resolve each symlink before processing '..': lexical normalization can hide a bundle escape.
      while (pending.length) {
        const piece = pending.shift()!;
        if (!piece || piece === '.') continue;
        if (piece === '..') { if (resolved.length <= 1) invalid(); resolved.pop(); continue; }
        resolved.push(piece);
        if (pathKey(resolved[0]) !== pathKey(root)) invalid();
        const next = links.get(pathKey(resolved.join('/')));
        if (next !== undefined) {
          if (++followed > 60) invalid();
          resolved.pop(); pending.unshift(...next.split('/'));
        }
      }
    }
    return root;
  } catch (error) { if ((error as Error).message === 'UPDATE_ARCHIVE_INVALID') throw error; throw new Error('UPDATE_ARCHIVE_INVALID'); }
  finally { await file.close(); }
}
