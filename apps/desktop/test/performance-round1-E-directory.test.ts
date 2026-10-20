import {afterEach, beforeEach, expect, it} from 'vitest';
import {lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DirectoryCatalog} from '../src/directory-catalog';

let root: string;
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'mote-E-cursor-')));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const names=(page:Awaited<ReturnType<DirectoryCatalog['next']>>)=>page.candidates.map(item=>item.relativePath);

it('resumes strictly after a missing durable name and invalidates position on restore and rollback',async()=>{
  for(const name of ['B.txt','a.txt','z.txt','é.txt','中.txt'])await writeFile(join(root,name),'Generated');
  const catalog=new DirectoryCatalog(root);
  expect(names(await catalog.next(1,[]))).toEqual(['B.txt']);
  const checkpoint=catalog.checkpoint();
  catalog.savepoint();
  expect(names(await catalog.next(1,[]))).toEqual(['a.txt']);
  expect(catalog.previous('a.txt')).toBeUndefined();
  catalog.rollbackSavepoint();
  expect(catalog.checkpoint()).toEqual(checkpoint);
  expect(names(await catalog.next(1,[]))).toEqual(['a.txt']);
  catalog.restore(checkpoint);
  expect(names(await catalog.next(1,[]))).toEqual(['a.txt']);
  await rm(join(root,'B.txt'));await writeFile(join(root,'0.txt'),'Generated before cursor');
  const restarted=new DirectoryCatalog(root,checkpoint);
  expect(names(await restarted.next(100,[]))).toEqual(['a.txt','z.txt','é.txt','中.txt']);
  expect(restarted.inProgress).toBe(false);
});

it('keeps skipped-name advancement, stat fault epochs and final-item completion timing',async()=>{
  await mkdir(join(root,'nested'));await mkdir(join(root,'excluded'));
  for(const name of ['.hidden.txt','a.txt','bad.txt','z.txt','nested/n.txt','excluded/x.txt'])await writeFile(join(root,name),'Generated');
  await symlink(join(root,'a.txt'),join(root,'link.txt'));
  const inspect=async(path:string)=>{if(path===join(root,'bad.txt'))throw Error('Generated stat failure');return lstat(path);};
  const catalog=new DirectoryCatalog(root,undefined,inspect);
  const first=await catalog.next(1,['excluded']);
  expect(names(first)).toEqual(['a.txt']);expect(first.skipped).toBe(1);
  const second=await catalog.next(1,['excluded']);
  expect(names(second)).toEqual(['z.txt']);expect(second.skipped).toBe(3);expect(second.faulted).toBe(true);
  const checkpoint=catalog.checkpoint();
  expect(checkpoint.activeDirectory?.after).toBe('z.txt');
  const restarted=new DirectoryCatalog(root,checkpoint);
  const tail=await restarted.next(1,['excluded']);
  expect(names(tail)).toEqual(['nested/n.txt']);expect(tail.complete).toBe(false);expect(tail.faulted).toBe(true);
  expect(restarted.inProgress).toBe(true);
  const exhausted=await restarted.next(1,['excluded']);
  expect(names(exhausted)).toEqual([]);expect(exhausted.complete).toBe(false);expect(exhausted.faulted).toBe(true);
  expect(restarted.finishReconciliation()).toEqual([]);
  expect((await restarted.next(100,['excluded'])).complete).toBe(true);
});
