import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectUpdateArchive } from '../src/update-archive';
import { updateZip } from './update-fixtures';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-update-zip-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function inspect(entries: Parameters<typeof updateZip>[0]) { const path = join(directory, 'fixture.zip'); await writeFile(path, updateZip(entries)); return inspectUpdateArchive(path); }
it('accepts ordinary app entries and framework symlinks confined to the bundle', async () => {
  expect(await inspect([{ name: 'Mote.app/Contents/MacOS/Mote', text: 'synthetic' }, { name: 'Mote.app/Contents/Frameworks/F.framework/Versions/A/F', text: 'synthetic' }, { name: 'Mote.app/Contents/Frameworks/F.framework/Versions/Current', text: 'A', symlink: true }, { name: 'Mote.app/Contents/Frameworks/F.framework/F', text: 'Versions/Current/F', symlink: true }])).toBe('Mote.app');
});
it('rejects absolute/traversal paths and conflicting local ZIP headers before extraction', async () => {
  for (const name of ['../escape', '/absolute.app/file', 'Mote.app/../escape', 'Mote.app/a\\b', 'Mote.app/a\nb']) await expect(inspect([{ name }])).rejects.toThrow('UPDATE_ARCHIVE_INVALID');
  await expect(inspect([{ name: 'Mote.app/ok', localName: '../escape!' }])).rejects.toThrow();
});
it('rejects escaping/cyclic symlinks and entries extracted beneath a symlink', async () => {
  for (const entries of [
    [{ name: 'Mote.app/link', text: '/tmp/outside', symlink: true }],
    [{ name: 'Mote.app/link', text: '../outside', symlink: true }],
    [{ name: 'Mote.app/link', text: 'link', symlink: true }],
    [{ name: 'Mote.app/a', text: '.', symlink: true }, { name: 'Mote.app/a/escape', text: '../..', symlink: true }],
  ]) await expect(inspect(entries)).rejects.toThrow('UPDATE_ARCHIVE_INVALID');
});
it('rejects duplicate entries, multiple top-level apps and truncated archives', async () => {
  await expect(inspect([{ name: 'Mote.app/a' }, { name: 'Mote.app/a' }])).rejects.toThrow();
  await expect(inspect([{ name: 'Mote.app/a' }, { name: 'Other.app/a' }])).rejects.toThrow();
  const path = join(directory, 'bad.zip'); await writeFile(path, Buffer.from('synthetic truncation')); await expect(inspectUpdateArchive(path)).rejects.toThrow();
});
it('rejects path aliases on case-insensitive and Unicode-normalizing macOS filesystems', async () => {
  for (const entries of [
    [{ name: 'Mote.app/A' }, { name: 'Mote.app/a' }],
    [{ name: 'Mote.app/caf\u00e9' }, { name: 'Mote.app/cafe\u0301' }],
    [{ name: 'Mote.app/\u03c3' }, { name: 'Mote.app/\u03c2' }],
    [{ name: 'Mote.app/link', text: '.', symlink: true }, { name: 'Mote.app/LINK/escape' }],
    [{ name: 'Mote.app/file' }, { name: 'Mote.app/file/child' }],
  ]) await expect(inspect(entries)).rejects.toThrow('UPDATE_ARCHIVE_INVALID');
});
it('resolves symlinks before parent traversal instead of erasing the link lexically', async () => {
  for (const target of ['dir/up/../outside', 'DIR/UP/../outside']) {
    await expect(inspect([
      { name: 'Mote.app/dir/up', text: '..', symlink: true },
      { name: 'Mote.app/link', text: target, symlink: true },
    ])).rejects.toThrow('UPDATE_ARCHIVE_INVALID');
  }
});
