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
  it('marks truncated indexes as lightweight and undecodable content as unsupported', async () => {
    await writeFile(join(root, 'large.md'), 'x'.repeat(100001)); await writeFile(join(root, 'invalid.md'), Buffer.from([0xff, 0xfe])); await writeFile(join(root, 'limit.md'), 'a'.repeat(100000));
    const result = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS); expect(result.items).toHaveLength(3);expect(result.items.find(i=>i.title==='large.md')?.document?.fileIndex?.coverage).toBe('lightweight');expect(result.items.find(i=>i.title==='invalid.md')?.document?.fileIndex?.status).toBe('unsupported');expect(result.items.find(i=>i.title==='limit.md')?.text.length).toBe(100000);expect(result.seen).toHaveLength(3);expect(result.complete).toBe(true);
  });
  it('reference mode emits only metadata and does not decode file bodies', async () => {
    await writeFile(join(root, 'synthetic.md'), Buffer.from([0xff, 0xfe]));
    const result = await scanSourceFiles(root, { ...DEFAULT_SOURCE_OPTIONS, retention: 'reference' });
    expect(result.items[0].text).toBe(''); expect(result.items[0].layer).toBe('reference'); expect(result.complete).toBe(true);
  });
  it('persists a directory catalog, skips unchanged content, and notices a new file on the next reconciliation', async () => {
    await writeFile(join(root, 'a.md'), 'a'); await writeFile(join(root, 'b.md'), 'b');
    const first = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS);
    const second = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS, undefined, undefined, undefined, first.checkpoint as any);
    expect(second.complete).toBe(true); expect(second.items).toEqual([]); expect(second.seen).toHaveLength(2);
    await writeFile(join(root, 'c.md'), 'c');
    const third = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS, undefined, undefined, undefined, second.checkpoint as any);
    expect(third.items.map(item => item.title)).toEqual(['c.md']);
  });
  it('pauses a large reconciliation and resumes from its durable directory cursor', async () => {
    await Promise.all(Array.from({ length: 2005 }, (_, index) => writeFile(join(root, `part-${String(index).padStart(4, '0')}.md`), 'fixture')));
    const first = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS);
    expect(first.complete).toBe(false); expect(first.items).toHaveLength(2000);
    const second = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS, undefined, undefined, undefined, first.checkpoint as any);
    expect(second.complete).toBe(true); expect(second.items).toHaveLength(5); expect(second.seen).toHaveLength(2005);
  });
  it('new-only baselines existing files without uploading them, then captures a later modification', async () => {
    await writeFile(join(root, 'old.md'), 'old');
    const options = { ...DEFAULT_SOURCE_OPTIONS, initialSync: 'new_only' as const };
    const first = await scanSourceFiles(root, options);
    expect(first.items).toEqual([]); expect(first.complete).toBe(true);
    const second = await scanSourceFiles(root, options, undefined, undefined, undefined, first.checkpoint as any);
    expect(second.items).toEqual([]);
    await writeFile(join(root, 'old.md'), 'new');
    const third = await scanSourceFiles(root, options, undefined, undefined, undefined, second.checkpoint as any);
    expect(third.items[0]?.text).toBe('new');
  });
  it('validates explicit rule boundaries instead of silently weakening them', () => {
    for (const change of [{ excludedPaths: ['../outside'] }, { extensions: ['md'] }, { redactLiterals: [''] }, { intervalSeconds: 1 }, { retention: 'other' }]) expect(() => normalizeSourceOptions({ ...DEFAULT_SOURCE_OPTIONS, ...change })).toThrow();
  });
});

it('invalidates cached directory listings between reconciliations in the same catalog instance', async () => {
  const { DirectoryCatalog } = await import('../src/directory-catalog');
  await writeFile(join(root, 'first.txt'), 'Generated');
  const catalog = new DirectoryCatalog(root);
  const first = await catalog.next(100, []); expect(first.complete).toBe(true); catalog.finishReconciliation();
  await writeFile(join(root, 'second.txt'), 'Generated');
  const second = await catalog.next(100, []); expect(second.candidates.map(c => c.relativePath)).toEqual(['first.txt', 'second.txt']);
});
