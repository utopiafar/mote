import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ProcessingRuntime,ProcessingFailure} from '../src/processing-runtime.js';
const capture=(text='Generated value 41',at='2026-09-18T10:00:00.000Z')=>({id:randomUUID(),deviceId:'generated',deviceName:'Generated fixture',platform:'macos',capturedAt:at,durationMs:5000,source:'ui_page',appId:'fixture',appName:'Fixture',windowTitle:'Page A',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'}});
// ui_page requires the native UI contract; screen text fixtures do not need a real image.
const observation=(text?:string,at?:string)=>({...capture(text,at),source:'note',durationMs:0});
function fixture(t:any,options={}){const path=mkdtempSync(join(tmpdir(),'mote-architecture-'));const store=new Store(path,options);t.after(()=>{store.close();rmSync(path,{recursive:true,force:true});});return store;}
const sourceItem=(n:number)=>({externalId:'file-'+n,revision:'v1',observedAt:'2026-09-18T10:00:00Z',title:'Generated '+n,text:'Generated document '+n,kind:'file',layer:'snapshot'});

test('source batch is one atomic transaction: late conflict, invalid item and revocation acknowledge nothing',async t=>{
 const store=fixture(t),sources=new SourceStore(store);sources.register({id:'nas',name:'Generated NAS',kind:'custom',deviceId:'generated',platform:'import'});
 await sources.upsert('nas',sourceItem(9));const before=store.logicalBytes();
 await assert.rejects(sources.upsertBatch('nas',[sourceItem(1),{...sourceItem(9),text:'changed'}]),{statusCode:409});assert.equal(store.stats().captures,1);assert.equal(store.logicalBytes(),before);
 let checks=0;await assert.rejects(sources.upsertBatch('nas',[sourceItem(1),sourceItem(2)],()=>{if(++checks>1)throw Error('revoked');}));assert.equal(store.stats().captures,1);
 const results=await Promise.all([sources.upsertBatch('nas',[sourceItem(1),sourceItem(2)]),sources.upsert('nas',sourceItem(1))]);assert.equal(results[1].duplicate,true);assert.equal(store.stats().captures,3);
});
test('settled capture batch keeps successes but rejects conflicting members; capacity ledger rolls back savepoints',async t=>{
 const store=fixture(t,{maxStorageBytes:100000});const a=observation(),b=observation('Other');await store.ingest(a);const baseline=store.logicalBytes();
 const result=await store.ingestSettled([a,{...a,ocrText:'Conflicting'},b] as any);assert.equal(result[0].result?.duplicate,true);assert.ok(result[1].error);assert.equal(result[2].result?.duplicate,false);assert.equal(store.stats().captures,2);assert.ok(store.logicalBytes()>baseline);
 const after=store.logicalBytes();await assert.rejects(store.ingestBatch([observation('Valid'),{...b,ocrText:'conflicting'}]));assert.equal(store.logicalBytes(),after);assert.equal(store.stats().captures,2);
});
test('ledger follows insert/update/delete and rollback without archive-sized scans',async t=>{
 const store=fixture(t),a=observation();await store.ingest(a);const first=store.logicalBytes();
 store.db.exec('BEGIN');store.db.prepare('UPDATE captures SET json=json_set(json,\'$.ocrText\',?) WHERE id=?').run('Longer generated text '.repeat(20),a.id);assert.ok(store.logicalBytes()>first);store.db.exec('ROLLBACK');assert.equal(store.logicalBytes(),first);
 store.delete(a.id);assert.equal(store.stats().captures,0);assert.ok(store.logicalBytes()<first);
});
test('exact aggregation preserves every observation, number changes, scope and late arrivals',async t=>{
 const store=fixture(t);const a={...observation(),source:'screen',durationMs:5000},b={...a,id:randomUUID(),capturedAt:'2026-09-18T10:00:05Z'},c={...a,id:randomUUID(),ocrText:'Generated value 42',capturedAt:'2026-09-18T10:00:10Z'};
 // Use image-free activity? Screen transport requires an image; generated image only.
 const sharp=(await import('sharp')).default;const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#ddeeff'}}).png().toBuffer();
 const inputs=[a,b,c].map(r=>({...r,imageMime:'image/png',imageBase64:bytes.toString('base64')}));await store.ingestBatch(inputs);store.archive.aggregate();
 const page=store.archive.page();assert.equal(page.items.length,1);const segment=page.items[0]!;assert.equal(segment.members.length,3);assert.equal(segment.representatives.length,2);assert.match(segment.text,/41/);assert.match(segment.text,/42/);
 assert.equal(store.archive.page({deviceId:'other'}).items.length,0);assert.equal(store.archive.page({after:'2026-09-18T10:00:06Z'}).items.length,0);
 const revision=segment.revision;await store.ingest({...inputs[0],id:randomUUID(),capturedAt:'2026-09-18T10:00:03Z'});store.archive.aggregate();assert.notEqual(store.archive.page().items[0]!.revision,revision);assert.equal(store.archive.get(store.archive.page().items[0]!.id)!.members.length,4);
 store.delete(c.id);assert.equal(store.archive.page().items.length,0);store.archive.aggregate();assert.doesNotMatch(store.archive.page().items[0]!.text,/42/);
});
test('artifact deletion cannot resurrect forgotten evidence; precise text is retained for fallback',async t=>{
 const store=fixture(t);const a=observation('😀'.repeat(10000));await store.ingest(a);store.archive.aggregate();const artifact=store.archive.page({maxCharacters:24000}).items[0]!;assert.equal(artifact.metadata.complete,false);assert.equal(store.evidence([a.id])[0].ocrText,a.ocrText);
 store.delete(a.id);store.archive.aggregate();store.archive.collect();assert.equal(store.archive.stats().contents,0);assert.equal(store.archive.stats().artifacts,0);await assert.rejects(store.ingest(a),{statusCode:410});
});
test('workflow DAG validates cycles/missing deps, caches versions and commits multiple artifacts',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation();await store.ingest(a);let calls=0;
 runtime.registry.register({id:'fixture.extract',version:'1',lane:'extract',async process(){calls++;return [{kind:'text',text:'Extracted 41',metadata:{}},{kind:'index',text:'Index',metadata:{}}];}});
 runtime.registry.register({id:'fixture.semantic',version:'1',lane:'semantic',async process(input){assert.equal(input.artifacts.length,1);return [{kind:'semantic',text:'Interpreted',metadata:{}}];}});
 assert.throws(()=>runtime.enqueue([{name:'a',processor:'fixture.extract',inputs:[a.id],dependsOn:['b']},{name:'b',processor:'fixture.extract',inputs:[a.id],dependsOn:['a']}]),/cycle/);
 assert.throws(()=>runtime.enqueue([{name:'a',processor:'fixture.extract',inputs:[a.id],dependsOn:['missing']}]),/Missing/);
 const graph=[{name:'extract',processor:'fixture.extract',inputs:[a.id],config:{b:2,a:1}},{name:'semantic',processor:'fixture.semantic',inputs:[a.id],dependsOn:['extract']}];const jobs=runtime.enqueue(graph);await runtime.tick();await runtime.tick();assert.equal(calls,1);assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(jobs.semantic)!.state,'succeeded');
 assert.equal(runtime.enqueue([{...graph[0],config:{a:1,b:2}},graph[1]]).extract,jobs.extract);await runtime.tick();assert.equal(calls,1);assert.equal(store.archive.stats().artifacts,3);
});
test('lane budget, retries, permanent failures, stale input and cancellation are durable',async t=>{
 const store=fixture(t);let now=Date.parse('2026-09-20T00:00:00Z');const runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:2,dailyCalls:1}},()=>now);t.after(()=>runtime.close());const a=observation(),b=observation();await store.ingestBatch([a,b]);let calls=0;
 runtime.registry.register({id:'fixture.fail',version:'1',lane:'semantic',async process(){calls++;throw new ProcessingFailure('transient');}});
 const ids=runtime.enqueue([{name:'a',processor:'fixture.fail',inputs:[a.id]},{name:'b',processor:'fixture.fail',inputs:[b.id]}]);await runtime.tick();assert.equal(calls,1);assert.equal(store.db.prepare('SELECT error FROM processing_jobs WHERE id=?').get(ids.b)!.error,'daily_budget');
 now+=86400000;await runtime.tick();assert.equal(calls,2);runtime.cancel(ids.a);assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(ids.a)!.state,'cancelled');
 store.delete(b.id);now+=86400000;await runtime.tick();assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(ids.b)!.state,'stale');assert.equal(calls,2);
});
test('in-flight source deletion and expired leases fence late completions',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation();await store.ingest(a);let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const start=new Promise<void>(resolve=>{started=resolve;});
 runtime.registry.register({id:'fixture.wait',version:'1',lane:'extract',async process(){started();await waiting;return [{kind:'text',text:'Must not reappear',metadata:{}}];}});
 const id=runtime.enqueue([{name:'a',processor:'fixture.wait',inputs:[a.id]}]).a;const running=runtime.tick();await start;store.delete(a.id);release();await running;assert.equal(store.archive.stats().artifacts,0);assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(id)!.state,'stale');
});
test('vector scoring reaches historical evidence outside the former recent candidate window',async t=>{
 const store=fixture(t),inputs=Array.from({length:4097},()=>observation());for(let i=0;i<inputs.length;i+=500)await store.ingestBatch(inputs.slice(i,i+500));store.db.exec("UPDATE captures SET embedding='[0,1]',embedding_model='fixture'");
 store.db.prepare("UPDATE captures SET embedding='[1,0]',captured_at='2020-01-01T00:00:00Z' WHERE id=?").run(inputs[0].id);
 const result=store.vectorSearch([1,0],'fixture',{limit:3});assert.equal(result.length,3);assert.equal(result[0].id,inputs[0].id);assert.equal(result.coverage.scanned,4097);assert.equal(result.coverage.bounded,false);
});

test('source directory catalog paginates without losing same-title files and tracks revisions/deletes',async t=>{
 const {browseSourceCatalog}=await import('../src/source-catalog.js');const store=fixture(t),sources=new SourceStore(store);sources.register({id:'nas',name:'NAS',kind:'custom',deviceId:'generated',platform:'import'});
 const receipts=await sources.upsertBatch('nas',Array.from({length:5},(_,n)=>({...sourceItem(n),title:'same.txt',uri:`nas://generated/docs/${n}.txt`})));const dirs=browseSourceCatalog(store.db,'nas');assert.equal(dirs.directories[0].files,5);const parent=String(dirs.directories[0].parent);
 let cursor:string|null|undefined,ids:string[]=[];do{const page=browseSourceCatalog(store.db,'nas',{parent,cursor:cursor??undefined,limit:2});ids.push(...page.items.map(i=>String(i.id)));cursor=page.nextCursor;}while(cursor);assert.equal(new Set(ids).size,5);
 store.delete(receipts.receipts[0].id);assert.equal(browseSourceCatalog(store.db,'nas').directories[0].files,4);
 await sources.upsert('nas',{...sourceItem(1),revision:'v2',observedAt:'2026-09-19T00:00:00Z',uri:'nas://generated/moved/1.txt'});assert.equal(browseSourceCatalog(store.db,'nas').directories.length,2);
});
test('dependent artifact lineage preserves invalidation without expanding ancestor execution inputs',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation('Parent'),b=observation('Child');await store.ingestBatch([a,b]);
 runtime.registry.register({id:'fixture.chain',version:'1',lane:'aggregate',async process(input){if(input.artifacts.length){assert.equal(input.artifacts[0].outputs[0].text,'Derived');assert.deepEqual(input.observations.map(r=>r.id),[b.id]);}return [{kind:'derived',text:'Derived',metadata:{}}];}});
 const jobs=runtime.enqueue([{name:'parent',processor:'fixture.chain',inputs:[a.id]},{name:'child',processor:'fixture.chain',inputs:[b.id],dependsOn:['parent']}]);await runtime.tick();await runtime.tick();const child=JSON.parse(String(store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(jobs.child)!.json));assert.equal(store.archive.get(child.outputs[0])!.members.length,1);assert.equal(store.archive.get(child.outputs[0])!.parents!.length,1);store.delete(a.id);assert.equal(store.archive.get(child.outputs[0]),undefined);
});
test('restart recovers expired lease once and permanently failing parent blocks descendants',async t=>{
 const store=fixture(t);let now=1000;const runtime=new ProcessingRuntime(store,[],{},()=>now);t.after(()=>runtime.close());const a=observation();await store.ingest(a);let calls=0;runtime.registry.register({id:'fixture.permanent',version:'1',lane:'extract',async process(){calls++;throw new ProcessingFailure('permanent');}});
 const jobs=runtime.enqueue([{name:'parent',processor:'fixture.permanent',inputs:[a.id]},{name:'child',processor:'fixture.permanent',inputs:[a.id],dependsOn:['parent']}]);store.db.prepare("UPDATE execution_steps SET state='running',lease_until=100,attempts=1,fence='old' WHERE id=?").run(jobs.parent);await runtime.tick();await runtime.tick();assert.equal(calls,1);assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(jobs.child)!.state,'blocked');
});
test('a stalled semantic lane does not stop new extraction work and cancellation fences its result',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation(),b=observation('Second');await store.ingestBatch([a,b]);let started!:()=>void;const begin=new Promise<void>(resolve=>{started=resolve;});let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let extracted=0;
 runtime.registry.register({id:'fixture.slow',version:'1',lane:'semantic',async process(){started();await wait;return [{kind:'semantic',text:'Late result',metadata:{}}];}});runtime.registry.register({id:'fixture.fast',version:'1',lane:'extract',async process(){extracted++;return [{kind:'text',text:'Fast',metadata:{}}];}});
 const slow=runtime.enqueue([{name:'slow',processor:'fixture.slow',inputs:[a.id]}]).slow;const running=runtime.tick();await begin;runtime.enqueue([{name:'fast',processor:'fixture.fast',inputs:[b.id]}]);await runtime.tick();assert.equal(extracted,1);runtime.cancel(slow);await running;release();assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(slow)!.state,'cancelled');assert.equal(store.archive.page({query:'Late result'}).items.length,0);
});
test('artifact revision changes fence a downstream job even when its original input is unchanged',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation();await store.ingest(a);store.archive.aggregate();const artifact=store.archive.page().items[0]!;let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const begin=new Promise<void>(resolve=>{started=resolve;});
 runtime.registry.register({id:'fixture.artifact',version:'1',lane:'semantic',async process(){started();await wait;return [{kind:'semantic',text:'Old revision',metadata:{}}];}});const job=runtime.enqueue([{name:'s',processor:'fixture.artifact',inputs:[a.id],artifactInputs:[{id:artifact.id,revision:artifact.revision}]}]).s;const running=runtime.tick();await begin;store.db.prepare('UPDATE context_artifacts SET revision=?,json=json_set(json,\'$.revision\',?) WHERE id=?').run('f'.repeat(64),'f'.repeat(64),artifact.id);release();await running;assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(job)!.state,'stale');assert.equal(store.archive.page({query:'Old revision'}).items.length,0);
});

test('oversized replay group is reported, preserves originals and becomes retryable after deletion',async t=>{
 const store=fixture(t);const sharp=(await import('sharp')).default;const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#ddeeff'}}).png().toBuffer();
 const inputs=Array.from({length:1001},()=>({...observation('Repeated generated text'),source:'screen',imageMime:'image/png',imageBase64:bytes.toString('base64')}));for(let i=0;i<inputs.length;i+=500)await store.ingestBatch(inputs.slice(i,i+500));store.archive.aggregate();assert.equal(store.archive.stats().blockedGroups,1);assert.equal(store.evidence([inputs[1000].id]).length,1);assert.equal(store.archive.aggregate(),0);
 store.delete(inputs[1000].id);store.archive.aggregate();assert.equal(store.archive.stats().blockedGroups,0);assert.equal(store.archive.stats().artifacts,10);assert.equal(store.archive.stats().observations,1000);
});
test('oversized processing input is blocked without spending a call; explicit policy change can retry it',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:1,dailyCalls:2,dailyInputCharacters:10}});t.after(()=>runtime.close());const a=observation('Too much generated input');await store.ingest(a);let calls=0;runtime.registry.register({id:'fixture.budget',version:'1',lane:'semantic',async process(){calls++;return [{kind:'semantic',text:'Done',metadata:{}}];}});const job=runtime.enqueue([{name:'s',processor:'fixture.budget',inputs:[a.id]}]).s;await runtime.tick();assert.equal(calls,0);assert.equal(store.db.prepare('SELECT error FROM processing_jobs WHERE id=?').get(job)!.error,'input_budget');const settings=runtime.settings();runtime.configure({...settings,semantic:{...settings.semantic,dailyInputCharacters:100}});runtime.retry(job);await runtime.tick();assert.equal(calls,1);
});
test('plugin withdrawal blocks queued work and a changed version gets a new cache identity',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation();await store.ingest(a);const processor={id:'fixture.version',version:'1',lane:'extract' as const,async process(){return [{kind:'text',text:'Versioned',metadata:{}}];}};const unregister=runtime.registry.register(processor);const first=runtime.enqueue([{name:'s',processor:processor.id,inputs:[a.id]}]).s;unregister();await runtime.tick();assert.equal(store.db.prepare('SELECT error FROM processing_jobs WHERE id=?').get(first)!.error,'processor_version_unavailable');runtime.registry.register({...processor,version:'2'});const second=runtime.enqueue([{name:'s',processor:processor.id,inputs:[a.id]}]).s;assert.notEqual(first,second);await runtime.tick();assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(second)!.state,'succeeded');
});

test('upgrading memory extraction resets a legacy evidence cursor exactly once',async t=>{
 const {MemoryLifecycle}=await import('../src/memory-lifecycle.js');const store=fixture(t),old=new MemoryLifecycle(store,()=>false);old.register({id:'extraction',version:'1',stream:'evidence',async run(){}});store.db.prepare("UPDATE memory_lifecycle_state SET json=? WHERE id='extraction'").run(JSON.stringify({cursor:900000,lastSuccess:0,failures:2,active:{version:'1'}}));const upgraded=new MemoryLifecycle(store,()=>false);upgraded.register({id:'extraction',version:'2',stream:'artifact',async run(){}});assert.equal(upgraded.view().extensions[0].cursor,0);store.db.prepare("UPDATE memory_lifecycle_state SET json=json_set(json,'$.cursor',9) WHERE id='extraction'").run();const reopened=new MemoryLifecycle(store,()=>false);reopened.register({id:'extraction',version:'2',stream:'artifact',async run(){}});assert.equal(reopened.view().extensions[0].cursor,9);
});

test('processing presentation exposes bounded steps and valid actions without raw configuration or content',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation('Generated private content');await store.ingest(a);
 runtime.registry.register({id:'fixture.presentation',version:'1',lane:'extract',async process(){throw new ProcessingFailure('permanent');}});
 const queued=runtime.enqueue([{name:'test',processor:'fixture.presentation',inputs:[a.id],config:{credential:'generated-only-secret'}}]);
 let view=runtime.view();assert.equal(view.jobs.length,1);assert.deepEqual(view.jobs[0].allowedActions,['cancel']);assert.equal(JSON.stringify(view).includes('generated-only-secret'),false);assert.equal(JSON.stringify(view).includes(a.ocrText),false);
 await runtime.tick();view=runtime.view();assert.equal(view.jobs[0].state,'failed');assert.deepEqual(view.jobs[0].allowedActions,['retry-step','cancel']);
 runtime.cancel(view.jobs[0].id);assert.deepEqual(runtime.view().jobs[0].allowedActions,['retry-step']);
});

test('legacy DAG authority migration preserves IDs, artifacts and interrupted retry counts',async t=>{
 const store=fixture(t),a=observation();await store.ingest(a);
 let runtime=new ProcessingRuntime(store),calls=0;
 const register=(fail=false)=>{runtime.registry.register({id:'fixture.migration',version:'1',lane:'extract',async process(input){calls++;if(fail&&input.config.child)throw new ProcessingFailure('transient');return [{kind:'text',text:input.config.child?'Migrated child':'Preserved parent',metadata:{}}];}});};register(true);
 const graph=[{name:'parent',processor:'fixture.migration',inputs:[a.id]},{name:'child',processor:'fixture.migration',inputs:[a.id],dependsOn:['parent'],config:{child:true}}];
 const ids=runtime.enqueue(graph);await runtime.tick();const parent=JSON.parse(String(store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(ids.parent)!.json));const original=store.archive.get(parent.outputs[0]);assert.ok(original);
 await runtime.close();
 // Generated legacy checkpoint: no common-engine authority existed before upgrade.
 store.db.exec("DELETE FROM execution_dependencies; DELETE FROM execution_operation_steps; DELETE FROM execution_steps; DELETE FROM settings WHERE key='execution-dag-v1'");
 store.db.prepare("UPDATE processing_jobs SET state='running',attempts=2,lease_until=1,available_at=0,fence='legacy' WHERE id=?").run(ids.child);
 runtime=new ProcessingRuntime(store);register();t.after(()=>runtime.close());
 assert.equal(runtime.engine.get(ids.parent)!.state,'succeeded');assert.equal(runtime.engine.get(ids.child)!.state,'waiting');assert.equal(runtime.engine.get(ids.child)!.attempts,2);
 assert.deepEqual(store.archive.get(parent.outputs[0]),original);const before=calls;await runtime.tick();assert.equal(calls,before+1);
 assert.equal(runtime.engine.get(ids.child)!.state,'succeeded');assert.equal(runtime.engine.get(ids.child)!.attempts,3);
 assert.deepEqual(runtime.enqueue(graph),ids);await runtime.tick();assert.equal(calls,before+1,'migration replay reran an existing result');
});

test('cached DAG steps can be traced from each operation without a second execution owner',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const a=observation();await store.ingest(a);let calls=0;
 runtime.registry.register({id:'fixture.operations',version:'1',lane:'extract',async process(){calls++;return [{kind:'text',text:'Generated operation output',metadata:{}}];}});
 const parent={name:'root',processor:'fixture.operations',inputs:[a.id]},first=runtime.enqueue([parent]);await runtime.tick();
 const second=runtime.enqueue([parent,{name:'child',processor:'fixture.operations',inputs:[a.id],dependsOn:['root']}]);assert.equal(second.root,first.root);await runtime.tick();
 const operations=store.db.prepare('SELECT operation_id FROM execution_operation_steps WHERE step_id=?').all(first.root);assert.equal(operations.length,2);
 assert.deepEqual(operations.map(o=>runtime.engine.list({operationId:String(o.operation_id)}).items.length).sort(),[1,2]);assert.equal(calls,2);
 assert.ok(store.db.prepare('SELECT fence,lease_until FROM processing_jobs').all().every(row=>row.fence===null&&row.lease_until===0),'legacy projection still owned execution leases');
});
