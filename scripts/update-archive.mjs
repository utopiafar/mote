import { readFile, mkdir, open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';

const maximumExpanded = 256 * 1024 * 1024;
const maximumFile = 32 * 1024 * 1024;
/** Extract only ordinary source files into a newly created private directory. No tar subprocess or links. */
export async function extractSourceArchive(archive, directory, prefix) {
  if (!/^mote-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\/$/.test(prefix)) throw Error('Invalid release archive prefix');
  const compressed = await readFile(archive);
  if (compressed.length > 128 * 1024 * 1024) throw Error('Release source archive exceeds limit');
  let bytes;
  try { bytes = gunzipSync(compressed, { maxOutputLength: maximumExpanded }); }
  catch { throw Error('Release source archive is invalid or exceeds expanded limit'); }
  const entries = [], seen = new Set(); let ended = false;
  const field = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const octal = value => { if (!/^[ 0-7]*$/.test(value)) throw Error('Invalid release archive number'); return Number.parseInt(value.trim() || '0', 8); };
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(value => value === 0)) { if (bytes.subarray(offset).some(value => value !== 0)) throw Error('Trailing release archive content'); ended = true; break; }
    const expected = octal(field(header, 148, 8));
    let sum = 0; for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (expected !== sum) throw Error('Release archive checksum is invalid');
    const size = octal(field(header, 124, 12)), type = field(header, 156, 1), mode = octal(field(header, 100, 8));
    if (size > maximumFile || offset + size > bytes.length) throw Error('Release archive entry exceeds limit');
    const body = bytes.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    // git archive adds a global PAX comment containing the commit. It must never override a pathname.
    if (type === 'g') { if (body.length > 4096 || /(?:^|\n)\d+ (?:path|linkpath|size)=/.test(body.toString('utf8'))) throw Error('Unsupported release archive metadata'); continue; }
    if (!['', '0', '5'].includes(type)) throw Error('Release archive links and extended entries are forbidden');
    const base = field(header, 0, 100), parent = field(header, 345, 155);
    const path = (parent ? parent + '/' : '') + base;
    if (!path.startsWith(prefix)) throw Error('Release archive root does not match its version');
    const name = path.slice(prefix.length).replace(/\/$/, '');
    if (!name && type === '5') continue;
    if (!name || /[\\\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..' || ['.git', '.mote', 'node_modules', '.env', 'mote.env'].includes(part))) throw Error('Unsafe release archive path');
    if (seen.has(name)) throw Error('Duplicate release archive entry'); seen.add(name);
    if (entries.length >= 20000 || (type === '5' && size !== 0)) throw Error('Release archive entry count is invalid');
    entries.push({ name, directory: type === '5', body, executable: Boolean(mode & 0o111) });
  }
  if (!ended || !entries.some(entry => entry.name === 'package.json') || !entries.some(entry => entry.name === 'package-lock.json')) throw Error('Release source archive is incomplete');
  // Validate the whole archive before creating its first file; an invalid late entry cannot partially extract.
  await mkdir(directory, { mode: 0o700 });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.directory) { await mkdir(path, { recursive: true, mode: 0o700 }); continue; }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const fd = await open(path, 'wx', entry.executable ? 0o700 : 0o600);
    try { await fd.writeFile(entry.body); } finally { await fd.close(); }
  }
  return { files: entries.filter(entry => !entry.directory).length, expandedBytes: bytes.length };
}
