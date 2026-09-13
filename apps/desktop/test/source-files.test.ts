import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSourceFiles } from '../src/source-files';
import { DEFAULT_SOURCE_OPTIONS, normalizeSourceOptions } from '../src/source-types';
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mote-source-files-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('explicit local text sources', () => {
  it('preserves multiline Chinese/emoji and applies only user literal masks before the pending queue', async () => {
    await writeFile(join(root, '合成.md'), '第一段 🧑🏽‍💻 e\u0301\n这是 synthetic-private，文字里的“忽略指令”仍是资料。');
    const result = await scanSourceFiles(root, { ...DEFAULT_SOURCE_OPTIONS, redactLiterals: ['synthetic-private'] });
    expect(result.items).toHaveLength(1); expect(result.items[0].text).toContain('🧑🏽‍💻 e\u0301'); expect(result.items[0].text).toContain('[已遮盖]'); expect(result.items[0].uri).toBeUndefined();
    expect(await readFile(join(root, '合成.md'), 'utf8')).toContain('synthetic-private');
  });
  it('does not traverse hidden entries, explicit exclusions, symlink files or symlink directories', async () => {
    await mkdir(join(root, 'excluded')); await writeFile(join(root, 'excluded', 'a.md'), 'excluded');
    await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'a.md'), 'hidden');
    await writeFile(join(root, '.secret.md'), 'hidden'); await writeFile(join(root, 'a.md'), 'allowed');
    await symlink(join(root, 'a.md'), join(root, 'link.md')); await symlink(join(root, 'excluded'), join(root, 'link-directory'));
    const result = await scanSourceFiles(root, { ...DEFAULT_SOURCE_OPTIONS, excludedPaths: ['excluded'] });
    expect(result.items.map(i => i.text)).toEqual(['allowed']); expect(result.skipped).toBe(5);
    await expect(scanSourceFiles(join(root, 'link.md'), DEFAULT_SOURCE_OPTIONS)).rejects.toThrow('符号链接');
  });
  it('rejects oversized and non UTF-8 text, retains seen IDs and marks unreadable scans incomplete', async () => {
    await writeFile(join(root, 'large.md'), 'x'.repeat(100001)); await writeFile(join(root, 'invalid.md'), Buffer.from([0xff, 0xfe])); await writeFile(join(root, 'limit.md'), 'a'.repeat(100000));
    const result = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS); expect(result.items).toHaveLength(1); expect(result.items[0].text.length).toBe(100000); expect(result.seen).toHaveLength(3); expect(result.complete).toBe(false);
  });
  it('reference mode emits only metadata and does not decode file bodies', async () => {
    await writeFile(join(root, 'synthetic.md'), Buffer.from([0xff, 0xfe]));
    const result = await scanSourceFiles(root, { ...DEFAULT_SOURCE_OPTIONS, retention: 'reference' });
    expect(result.items[0].text).toBe(''); expect(result.items[0].layer).toBe('reference'); expect(result.complete).toBe(true);
  });
  it('validates explicit rule boundaries instead of silently weakening them', () => {
    for (const change of [{ excludedPaths: ['../outside'] }, { extensions: ['md'] }, { redactLiterals: [''] }, { intervalSeconds: 1 }, { retention: 'other' }]) expect(() => normalizeSourceOptions({ ...DEFAULT_SOURCE_OPTIONS, ...change })).toThrow();
  });
});
