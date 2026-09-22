import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
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


it('a failed scan epoch survives restart and cannot turn unreadable paths into deletions', async () => {
  const {DirectoryCatalog}=await import('../src/directory-catalog');
  await writeFile(join(root,'a.txt'),'Generated root');
  for(const name of ['b','c','d']){await mkdir(join(root,name));await writeFile(join(root,name,'file.txt'),'Generated '+name);}
  const first=new DirectoryCatalog(root);expect((await first.next(100,[])).complete).toBe(true);first.finishReconciliation();
  const scan=new DirectoryCatalog(root,first.checkpoint());expect((await scan.next(1,[])).candidates[0].relativePath).toBe('a.txt');
  await rename(join(root,'b'),join(root,'.temporarily-unavailable'));
  const failed=await scan.next(1,[]);expect(failed.faulted).toBe(true);expect(scan.checkpoint().inProgress).toBe(true);
  const resumed=new DirectoryCatalog(root,scan.checkpoint());const tail=await resumed.next(100,[]);
  expect(tail.complete).toBe(false);expect(tail.faulted).toBe(true);expect(resumed.finishReconciliation()).toEqual([]);
  expect(resumed.catalog['b/file.txt']).toBeDefined();
  await rename(join(root,'.temporarily-unavailable'),join(root,'b'));
  expect((await resumed.next(100,[])).complete).toBe(true);expect(resumed.finishReconciliation()).toEqual([]);
  await rm(join(root,'b'),{recursive:true});expect((await resumed.next(100,[])).complete).toBe(true);
  expect(resumed.finishReconciliation()).toEqual(['b/file.txt']);
});


it('directory metadata I/O overlaps within four slots without reordering committed names',async()=>{
 const {DirectoryCatalog}=await import('../src/directory-catalog');
 for(let i=0;i<20;i++)await writeFile(join(root,String(i).padStart(2,'0')+'.txt'),'Generated');
 let active=0,peak=0;
 const catalog=new DirectoryCatalog(root,undefined,async path=>{active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,5));return await lstat(path);}finally{active--;}});
 const first=await catalog.next(7,[]),resumed=new DirectoryCatalog(root,catalog.checkpoint());const rest=await resumed.next(100,[]);
 expect(peak).toBe(4);expect(first.candidates.length).toBe(7);expect(rest.complete).toBe(true);
 expect([...first.candidates,...rest.candidates].map(item=>item.relativePath)).toEqual(Array.from({length:20},(_,i)=>String(i).padStart(2,'0')+'.txt'));
});

it('incremental catalog drafts preserve prior state until durable commit and roll back an unfinished shard',async()=>{
 const {DirectoryCatalog}=await import('../src/directory-catalog');
 const {SourceSync}=await import('../src/source-sync');
 const sync=new SourceSync(join(root,'state.json'));await sync.initialize();
 const selected=join(root,'selected');await mkdir(selected);await writeFile(join(selected,'a.txt'),'Generated first');
 const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,undefined,undefined,[],true);
 expect(first.checkpoint&&'root' in first.checkpoint?first.checkpoint.catalog:undefined).toEqual({});expect(first.catalogChanges).toHaveLength(1);
 await sync.stage(first,false);const old=sync.fileCheckpoint()!;expect(Object.keys(old.catalog)).toEqual(['a.txt']);
 const draft=new DirectoryCatalog(selected,old,undefined,true);draft.savepoint();
 const entry=old.catalog['a.txt'];draft.observe({path:join(selected,'a.txt'),...entry,size:123,quickHash:'changed'});
 expect(old.catalog['a.txt'].size).not.toBe(123);expect(draft.catalogChanges()).toHaveLength(1);
 draft.rollbackSavepoint();expect(draft.catalogChanges()).toEqual([]);expect(old.catalog['a.txt'].size).toBe(entry.size);
 await writeFile(join(selected,'a.txt'),'Generated changed');
 const changed=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,undefined,sync.fileCheckpoint(),[],true);
 expect(sync.fileCheckpoint()!.catalog['a.txt'].size).toBe(entry.size);await sync.stage(changed,false);
 const reopened=new SourceSync(join(root,'state.json'));await reopened.initialize();
 expect(reopened.fileCheckpoint()!.catalog['a.txt'].size).toBe(Buffer.byteLength('Generated changed'));
});
