import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rename,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanSourceFiles} from '../src/source-files';
import {DEFAULT_SOURCE_OPTIONS,type LocalSource} from '../src/source-types';
import {readSourceEvidence} from '../src/file-evidence';
import {randomUUID} from 'node:crypto';
it('stable identity survives rename, retired client index limits are ignored, and device reads stay unavailable',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-index-')));try{
 const path=join(root,'one.txt'),text='Generated evidence '.repeat(1000);await writeFile(path,text);const locations=new Map<string,string>();const options={...DEFAULT_SOURCE_OPTIONS,indexMode:'lightweight' as const,allowRead:true};
 const first=(await scanSourceFiles(root,options,undefined,undefined,locations)).items[0];expect(first.document?.fileIndex?.status).toBe('pending');expect(first.text.length).toBe(0);expect(first.document?.fileIndex?.maxIndexCharacters).toBe(100000);
 await rename(path,join(root,'two.txt'));const second=(await scanSourceFiles(root,options,undefined,undefined,locations)).items[0];expect(second.externalId).toBe(first.externalId);
 const source:LocalSource={...options,id:'generated-source',deviceId:'fixture',name:'Generated',kind:'local-files',platform:'macos',enabled:true,path:root};const request={id:randomUUID(),sourceId:source.id,externalId:second.externalId,revision:'r1',contentVersion:second.document!.fileIndex!.contentVersion,offset:9000,length:100};
 expect(await readSourceEvidence(source,request,locations)).toMatchObject({status:'unavailable',text:''});
 expect((await readSourceEvidence({...source,allowRead:false},request,locations)).status).toBe('denied');await writeFile(join(root,'two.txt'),'changed');expect((await readSourceEvidence(source,request,locations)).status).toBe('version_changed');
 }finally{await rm(root,{recursive:true,force:true});}
});


it('seventeen MiB snapshots stream durable chunks while the in-memory path stays bounded',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-generated-large-snapshot-')));try{
  const file=join(root,'generated.pdf'),bytes=Buffer.alloc(17*1024*1024+19,0x47);await writeFile(file,bytes);
  const options={...DEFAULT_SOURCE_OPTIONS,extensions:['.pdf'],retention:'snapshot' as const,centralProcessingConsent:true};
  expect((await scanSourceFiles(file,options)).items).toHaveLength(0);
  const result=await scanSourceFiles(file,options,undefined,join(root,'capture-state.atime.json'));
  expect(result.items).toHaveLength(1);const item=result.items[0],spool=item.localOriginal!;
  expect(item.text).toBe('');expect(item.localOriginalBase64).toBeUndefined();expect(item.document?.fileIndex?.parser).toBe('central-pending');
  expect(spool.sizeBytes).toBe(bytes.length);expect(spool.partBytes).toBe(4*1024*1024);
  const {originalPart}=await import('../src/original-spool');expect(await originalPart(spool,4)).toEqual(bytes.subarray(16*1024*1024));
  expect(spool.sha256).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
 }finally{await rm(root,{recursive:true,force:true});}
});


it('a large snapshot in a directory advances its checkpoint and never loses the prepared first file',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mote-generated-large-directory-'))),state=await realpath(await mkdtemp(join(tmpdir(),'mote-generated-source-state-')));try{
  await writeFile(join(root,'a.pdf'),Buffer.alloc(17*1024*1024,0x47));await writeFile(join(root,'b.pdf'),'generated second PDF');
  const options={...DEFAULT_SOURCE_OPTIONS,extensions:['.pdf'],retention:'snapshot' as const,centralProcessingConsent:true};
  const first=await scanSourceFiles(root,options,undefined,join(state,'source.atime.json'));expect(first.items).toHaveLength(1);expect(first.complete).toBe(false);
  expect(first.items[0].localOriginal?.sizeBytes).toBe(17*1024*1024);
  const second=await scanSourceFiles(root,options,undefined,join(state,'source.atime.json'),undefined,first.checkpoint);
  expect(second.items).toHaveLength(1);expect(second.items[0].title).not.toBe(first.items[0].title);expect(second.complete).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});await rm(state,{recursive:true,force:true});}
});
