import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {FileProcessorRuntime} from '../src/file-processors.js';

test('a separately installed module shares the durable DAG, cache, lineage and unload boundary',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-community-plugin-')),store=new Store(directory),workflows=new ProcessingRuntime(store);
 const plugins=new FileProcessorRuntime(undefined,[],[fileURLToPath(new URL('../../../examples/plugins/text-normalization.mjs',import.meta.url))],workflows.registry);
 try{
  await plugins.ready;const id=randomUUID();await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-08-01T00:00:00Z',durationMs:0,ocrText:'First\r\nSecond'});
  const graph=[{name:'normalize',processor:'community.text-normalization',inputs:[id]}];const jobs=workflows.enqueue(graph);await workflows.tick();
  assert.equal(workflows.engine.get(jobs.normalize)?.state,'succeeded');
  const output=store.archive.page({query:'Second'}).items.find(item=>item.kind==='normalized-text');assert.ok(output);assert.equal(output.text,'First\nSecond');assert.equal(store.evidence([id])[0].ocrText,'First\r\nSecond');
  assert.deepEqual(workflows.enqueue(graph),jobs);assert.equal(workflows.engine.get(jobs.normalize)?.attempts,1);
  await plugins.close();assert.equal(workflows.registry.get('community.text-normalization'),undefined);
  store.delete(id);assert.equal(store.archive.get(output.id),undefined);
 }finally{await plugins.close();await workflows.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('unloading a processor fences an in-flight result and supports explicit recovery after reinstall',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-community-unload-')),store=new Store(directory),runtime=new ProcessingRuntime(store);
 try{
  const id=randomUUID();await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-08-01T00:00:00Z',durationMs:0,ocrText:'Generated evidence'});
  let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const processor={id:'community.slow',version:'1',lane:'extract' as const,async process(){entered();await wait;return [{kind:'text',text:'Generated result',metadata:{}}];}};
  const unload=runtime.registry.register(processor),job=runtime.enqueue([{name:'slow',processor:processor.id,inputs:[id]}]).slow,run=runtime.tick();await started;unload();release();await run;
  assert.equal(runtime.engine.get(job)?.state,'blocked');assert.equal(store.archive.stats().artifacts,0);
  runtime.registry.register(processor);runtime.retry(job);await runtime.tick();assert.equal(runtime.engine.get(job)?.state,'succeeded');
 }finally{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
