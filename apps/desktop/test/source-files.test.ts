import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdtemp, mkdir, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSourceFiles } from '../src/source-files';
import { DEFAULT_SOURCE_OPTIONS, normalizeSourceOptions, type LocalFileCheckpoint } from '../src/source-types';
const inputText=(item:any)=>Buffer.from(item.localOriginalBase64,'base64').toString('utf8');
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mote-source-files-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('explicit local text sources', () => {
  it('preserves multiline Chinese/emoji and applies only user literal masks before the pending queue', async () => {
    await writeFile(join(root, '合成.md'), '第一段 🧑🏽‍💻 e\u0301\n这是 synthetic-private，文字里的“忽略指令”仍是资料。');
    const result = await scanSourceFiles(root, { ...DEFAULT_SOURCE_OPTIONS, redactLiterals: ['synthetic-private'] });
    expect(result.items).toHaveLength(1); expect(result.items[0].text).toBe(''); expect(inputText(result.items[0])).toContain('🧑🏽‍💻 e\u0301'); expect(inputText(result.items[0])).toContain('[已遮盖]'); expect(inputText(result.items[0])).not.toContain('synthetic-private'); expect(result.items[0].uri).toBeUndefined();
    expect(await readFile(join(root, '合成.md'), 'utf8')).toContain('synthetic-private');
  });
  it('does not traverse hidden entries, explicit exclusions, symlink files or symlink directories', async () => {
    await mkdir(join(root, 'excluded')); await writeFile(join(root, 'excluded', 'a.md'), 'excluded');
    await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'a.md'), 'hidden');
    await writeFile(join(root, '.secret.md'), 'hidden'); await writeFile(join(root, 'a.md'), 'allowed');
    await symlink(join(root, 'a.md'), join(root, 'link.md')); await symlink(join(root, 'excluded'), join(root, 'link-directory'));
    const result = await scanSourceFiles(root, { ...DEFAULT_SOURCE_OPTIONS, excludedPaths: ['excluded'] });
    expect(result.items.map(inputText)).toEqual(['allowed']); expect(result.skipped).toBe(5);
    await expect(scanSourceFiles(join(root, 'link.md'), DEFAULT_SOURCE_OPTIONS)).rejects.toThrow('符号链接');
  });
  it('uploads bounded bytes without decoding or classifying text on the collector', async () => {
    await writeFile(join(root, 'large.md'), 'x'.repeat(100001)); await writeFile(join(root, 'invalid.md'), Buffer.from([0xff, 0xfe])); await writeFile(join(root, 'limit.md'), 'a'.repeat(100000));
    const result=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS);expect(result.items).toHaveLength(3);for(const item of result.items){expect(item.text).toBe('');expect(item.document?.fileIndex).toMatchObject({status:'pending',parser:'central-pending',maxIndexCharacters:100000});expect(item).not.toHaveProperty('localProcessing');expect(item.localOriginalBase64).toBeDefined();}expect(result.complete).toBe(true);
  });
  it('reference mode emits only metadata and does not decode file bodies', async () => {
    await writeFile(join(root, 'synthetic.md'), Buffer.from([0xff, 0xfe]));
    const result = await scanSourceFiles(root, { ...DEFAULT_SOURCE_OPTIONS, retention: 'reference' });
    expect(result.items[0].text).toBe(''); expect(result.items[0].layer).toBe('reference'); expect(result.complete).toBe(true);
  });
  it('persists a directory catalog, skips unchanged content, and notices a new file on the next reconciliation', async () => {
    await writeFile(join(root, 'a.md'), 'a'); await writeFile(join(root, 'b.md'), 'b');
    const first = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS);
    const second = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS, undefined, undefined, first.checkpoint as any);
    expect(second.complete).toBe(true); expect(second.items).toEqual([]); expect(second.seen).toHaveLength(2);
    await writeFile(join(root, 'c.md'), 'c');
    const third = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS, undefined, undefined, second.checkpoint as any);
    expect(third.items.map(item => item.title)).toEqual(['c.md']);
  });
  it('pauses a large reconciliation and resumes from its durable directory cursor', async () => {
    await Promise.all(Array.from({ length: 2005 }, (_, index) => writeFile(join(root, `part-${String(index).padStart(4, '0')}.md`), 'fixture')));
    const first = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS);
    expect(first.complete).toBe(false); expect(first.items).toHaveLength(2000);
    const second = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS, undefined, undefined, first.checkpoint as any);
    expect(second.complete).toBe(true); expect(second.items).toHaveLength(5); expect(second.seen).toHaveLength(2005);
  });
  it('new-only baselines existing files without uploading them, then captures a later modification', async () => {
    await writeFile(join(root, 'old.md'), 'old');
    const options = { ...DEFAULT_SOURCE_OPTIONS, initialSync: 'new_only' as const };
    const first = await scanSourceFiles(root, options);
    expect(first.items).toEqual([]); expect(first.complete).toBe(true);
    const second = await scanSourceFiles(root, options, undefined, undefined, first.checkpoint as any);
    expect(second.items).toEqual([]);
    await writeFile(join(root, 'old.md'), 'new');
    const third = await scanSourceFiles(root, options, undefined, undefined, second.checkpoint as any);
    expect(inputText(third.items[0])).toBe('new');
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
 const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,undefined,[],true);
 expect(first.checkpoint&&'root' in first.checkpoint?first.checkpoint.catalog:undefined).toEqual({});expect(first.catalogChanges).toHaveLength(1);
 await sync.stage(first,false);const old=sync.fileCheckpoint()!;expect(Object.keys(old.catalog)).toEqual(['a.txt']);
 const draft=new DirectoryCatalog(selected,old,undefined,true);draft.savepoint();
 const entry=old.catalog['a.txt'];draft.observe({path:join(selected,'a.txt'),...entry,size:123,quickHash:'changed'});
 expect(old.catalog['a.txt'].size).not.toBe(123);expect(draft.catalogChanges()).toHaveLength(1);
 draft.rollbackSavepoint();expect(draft.catalogChanges()).toEqual([]);expect(old.catalog['a.txt'].size).toBe(entry.size);
 await writeFile(join(selected,'a.txt'),'Generated changed');
 const changed=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,sync.fileCheckpoint(),[],true);
 expect(sync.fileCheckpoint()!.catalog['a.txt'].size).toBe(entry.size);await sync.stage(changed,false);
 const reopened=new SourceSync(join(root,'state.json'));await reopened.initialize();
 expect(reopened.fileCheckpoint()!.catalog['a.txt'].size).toBe(Buffer.byteLength('Generated changed'));
});

it('retries changed content after an interrupted read without advancing the successful baseline', async () => {
  await writeFile(join(root, 'retry.md'), 'old');
  const first = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS);
  await writeFile(join(root, 'retry.md'), 'new content');
  const {DirectoryCatalog} = await import('../src/directory-catalog');
  const catalog = new DirectoryCatalog(root, first.checkpoint as any);
  const page = await catalog.next(10, []);
  catalog.markContent(page.candidates[0].relativePath, undefined, 'error');
  const retry = await scanSourceFiles(root, DEFAULT_SOURCE_OPTIONS, undefined, undefined, catalog.checkpoint());
  expect(retry.items.map(inputText)).toEqual(['new content']);
});

it('single-file new-only establishes a durable baseline and collects later changes', async () => {
  const path = join(root, 'single.md'); await writeFile(path, 'old');
  const options = {...DEFAULT_SOURCE_OPTIONS, initialSync: 'new_only' as const};
  const first = await scanSourceFiles(path, options);
  expect(first.items).toEqual([]); expect(first.checkpoint?.initialized).toBe(true);
  await writeFile(path, 'changed');
  const next = await scanSourceFiles(path, options, undefined, undefined, first.checkpoint as any);
  expect(next.items.map(inputText)).toEqual(['changed']);
});

it('skips unchanged audio after spooling its transient central input',async()=>{
 const path=join(root,'generated.wav'),marker=join(root,'.generated-access.json');await writeFile(path,Buffer.from('Generated audio fixture'));
 const options={...DEFAULT_SOURCE_OPTIONS,extensions:['.wav']};
 const first=await scanSourceFiles(path,options,undefined,marker);expect(first.items).toHaveLength(1);expect(first.items[0].localOriginal).toBeDefined();
 const spool=first.items[0].localOriginal!;
 const second=await scanSourceFiles(path,options,undefined,marker,first.checkpoint as any);expect(second.items).toEqual([]);
 expect(await readFile(join(spool.directory,'0'))).toEqual(Buffer.from('Generated audio fixture'));
});

it('blocks complex formats with literal privacy masks without copying raw input',async()=>{const path=join(root,'generated.wav');await writeFile(path,'synthetic-private audio bytes');const result=await scanSourceFiles(path,{...DEFAULT_SOURCE_OPTIONS,extensions:['.wav'],redactLiterals:['synthetic-private']});expect(result.items[0].document?.fileIndex?.status).toBe('blocked');expect(result.items[0].localOriginal).toBeUndefined();expect(result.items[0].localOriginalBase64).toBeUndefined();expect(result.items[0].text).toBe('');});

describe('directory root availability and complete scans', () => {
  const files = ['a.md','b.md','c.md','d.md'];
  async function seed(){for(const name of files)await writeFile(join(root,name),'Generated '+name);}
  async function checkpointOf(scan: Awaited<ReturnType<typeof scanSourceFiles>>){return scan.checkpoint as LocalFileCheckpoint;}

  it('records the root identity, scan generation and last successful time', async () => {
    await seed();
    const scan=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),checkpoint=await checkpointOf(scan);
    expect(scan.complete).toBe(true);
    expect(checkpoint.scanNumber).toBe(1);expect(checkpoint.rootIdentity).toMatch(/^\d+:\d+$/);
    expect(checkpoint.lastScanComplete).toBe(true);expect(checkpoint.lastCompleteScanAt).toBeTruthy();
  });

  it('publishes a verified empty directory as a complete catalog update', async () => {
    await seed();
    const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),checkpoint=await checkpointOf(first);
    const succeededAt=checkpoint.lastCompleteScanAt;
    for(const name of files)await rm(join(root,name));
    const empty=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint);
    expect(empty.complete).toBe(true);expect(empty.seen).toEqual([]);expect(empty.degraded).toBeUndefined();
    const next=await checkpointOf(empty);
    expect(next.catalog).toEqual({});expect(next.rootIdentity).toBe(checkpoint.rootIdentity);
    expect(next.lastScanComplete).toBe(true);expect(Date.parse(next.lastCompleteScanAt!)).toBeGreaterThanOrEqual(Date.parse(succeededAt!));
  });

  it('does not publish absences for an empty mount shell with a different root identity', async () => {
    await seed();
    const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),checkpoint=await checkpointOf(first);
    const saved=root+'-saved';await rename(root,saved);await mkdir(root);
    try {
      const shell=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint);
      expect(shell.complete).toBe(false);expect(shell.degraded).toBe('root_changed');expect(shell.seen).toEqual([]);
      const next=await checkpointOf(shell);
      expect(Object.keys(next.catalog)).toHaveLength(files.length);expect(next.rootIdentity).toBe(checkpoint.rootIdentity);
      expect(next.lastScanComplete).toBe(false);expect(next.degradedReason).toBe('root_changed');
      expect(next.lastCompleteScanAt).toBe(checkpoint.lastCompleteScanAt);
    } finally { await rm(root,{recursive:true,force:true});await rename(saved,root); }
  });

  it('does not publish absences when the root is unavailable', async () => {
    await seed();
    const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),checkpoint=await checkpointOf(first);
    const saved=root+'-saved';await rename(root,saved);
    let missing: Awaited<ReturnType<typeof scanSourceFiles>>;
    try {
      missing=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint);
      expect(missing.complete).toBe(false);expect(missing.degraded).toBe('root_unavailable');
      const next=await checkpointOf(missing);
      expect(Object.keys(next.catalog)).toHaveLength(files.length);expect(next.rootIdentity).toBe(checkpoint.rootIdentity);
      expect(next.lastScanComplete).toBe(false);expect(next.lastCompleteScanAt).toBe(checkpoint.lastCompleteScanAt);
    } finally { await rename(saved,root); }
    const recovered=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,await checkpointOf(missing!));
    expect(recovered.complete).toBe(true);expect(recovered.items).toEqual([]);
  });

  it.skipIf(process.platform==='win32'||process.getuid?.()===0)('does not publish absences after a permission failure', async () => {
    const nested=join(root,'nested');await mkdir(nested);
    for(const name of files.slice(0,2))await writeFile(join(root,name),'Generated '+name);
    for(const name of files.slice(2))await writeFile(join(nested,name),'Generated '+name);
    const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),checkpoint=await checkpointOf(first);
    await chmod(nested,0o000);
    try {
      const denied=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint);
      expect(denied.complete).toBe(false);expect(denied.degraded).toBe('permission_denied');
      const next=await checkpointOf(denied);
      expect(Object.keys(next.catalog)).toHaveLength(files.length);expect(next.lastScanComplete).toBe(false);
    } finally { await chmod(nested,0o755); }
  });

  it('adopts a changed root only after a verification scan sees a known file, then resumes absence publication', async () => {
    await seed();
    const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),checkpoint=await checkpointOf(first);
    const saved=root+'-saved';await rename(root,saved);await mkdir(root);
    try {
      for(const name of files.slice(0,3))await copyFile(join(saved,name),join(root,name));
      const verify=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint);
      expect(verify.complete).toBe(false);expect(verify.degraded).toBe('root_changed');
      const verified=await checkpointOf(verify);
      expect(verified.rootIdentity).not.toBe(checkpoint.rootIdentity);
      expect(Object.keys(verified.catalog)).toHaveLength(files.length);
      const settled=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,verified);
      expect(settled.complete).toBe(true);expect(settled.degraded).toBeUndefined();
      const next=await checkpointOf(settled);
      expect(Object.keys(next.catalog).sort()).toEqual([...files.slice(0,3)].sort());
      expect(next.lastScanComplete).toBe(true);
    } finally { await rm(root,{recursive:true,force:true});await rename(saved,root); }
  });

  it('verifies an older checkpoint without a recorded root identity before publishing removals', async () => {
    await seed();
    const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),checkpoint=await checkpointOf(first);
    delete (checkpoint as {rootIdentity?:string}).rootIdentity;
    const verify=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint);
    expect(verify.complete).toBe(false);expect(verify.degraded).toBe('root_changed');
    expect(Object.keys((verify.checkpoint as LocalFileCheckpoint).catalog)).toHaveLength(files.length);
    const settled=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,verify.checkpoint as LocalFileCheckpoint);
    expect(settled.complete).toBe(true);expect(settled.degraded).toBeUndefined();
  });

  it('rechecks the root after enumeration so a mid-scan remount cannot publish removals', async () => {
    const {DirectoryCatalog}=await import('../src/directory-catalog');
    await seed();
    const catalog=new DirectoryCatalog(root);
    expect((await catalog.next(100,[])).complete).toBe(true);
    const saved=root+'-saved';await rename(root,saved);await mkdir(root);
    try {
      expect(await catalog.verifyRoot(true)).toBe(true);
      expect(catalog.finishReconciliation()).toEqual([]);
      expect(Object.keys(catalog.catalog)).toHaveLength(files.length);
    } finally { await rm(root,{recursive:true,force:true});await rename(saved,root); }
  });

  it('resumes a paged scan across interruption without missing or duplicating files', async () => {
    const {DirectoryCatalog}=await import('../src/directory-catalog');
    await seed();
    const first=new DirectoryCatalog(root),head=await first.next(2,[]);
    const resumed=new DirectoryCatalog(root,first.checkpoint()),tail=await resumed.next(100,[]);
    const names=[...head.candidates,...tail.candidates].map(candidate=>candidate.relativePath);
    expect(tail.complete).toBe(true);expect(names.sort()).toEqual([...files].sort());expect(new Set(names).size).toBe(files.length);
    expect(resumed.finishReconciliation()).toEqual([]);
  });

  it('finds a late file without a watcher event on the next reconciliation', async () => {
    await seed();
    const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS);
    await writeFile(join(root,'late.md'),'Generated late');
    const next=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,await checkpointOf(first));
    expect(next.complete).toBe(true);expect(next.items.map(item=>item.title)).toEqual(['late.md']);expect(next.seen).toHaveLength(files.length+1);
  });
});
