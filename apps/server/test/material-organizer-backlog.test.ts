import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileAttachments} from '../src/file-attachments.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {Operations} from '../src/operations.js';

function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-organizer-backlog-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials),archived=new ArchivedFileStore(store);
 sources.register({id:'generated',name:'Generated source',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});
 t.after(async()=>{await organizers.close();await organizers.executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,sources,files,materials,organizers,archived};
}
const item=(externalId:string,revision='1',text='Generated original '+externalId)=>({externalId,revision,text,observedAt:'2026-10-01T00:00:00Z',kind:'message' as const,layer:'original' as const});

test('a bounded publication wave does not run selectors across a thousand unrelated pending source identities',async t=>{
 const {sources,organizers,materials,store}=fixture(t);let selections=0;
 const select=organizers.registry.select.bind(organizers.registry);organizers.registry.select=record=>{selections++;return select(record);};
 for(let offset=0;offset<1000;offset+=500)await sources.upsertBatch('generated',Array.from({length:500},(_,index)=>item(String(offset+index))));
 assert.equal(await organizers.tick(200),200);
 assert.equal(Number(store.db.prepare('SELECT count(*) n FROM material_heads').get()!.n),200);
 assert.ok(selections<=2000,`Source identity validation must remain bounded; observed ${selections} selector calls`);
 for(let index=0;index<200;index++)assert.ok(materials.get(materialId('generated',String(index))));
 assert.equal(organizers.status().pendingSteps,0,'the real drain fills every publication wave, not only its first eight slots');
});

for(const change of ['revision','delete','attachment'] as const)test(`a source-item snapshot held during ${change} rejects its late publication`,async t=>{
 const {sources,organizers,materials,store,files,archived}=fixture(t);
 const original=archived.put({name:'generated.txt',mimeType:'text/plain',bytes:Buffer.from('Generated attachment')});
 const parent=await sources.upsert('generated',{...item('parent'),document:{attachments:[{id:original.id,name:original.name,mimeType:original.mimeType}]}});archived.attach(parent.id,[original.id]);
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
 // Pause the actual asynchronous snapshot boundary while tick() uses normal
 // discovery, claim, source reading and commit fences. No internal step is made.
 const boundary=organizers as unknown as {readSourceHead:(sourceId:string,externalId:string,signal:AbortSignal)=>Promise<unknown>};
 const read=boundary.readSourceHead.bind(organizers);let paused=false;
 boundary.readSourceHead=async(...args)=>{const value=await read(...args);if(args[1]==='parent'&&!paused){paused=true;enter();await held;}return value;};
 const running=organizers.tick(200);await entered;
 if(change==='revision')await sources.upsert('generated',item('parent','2','Generated current revision'));
 else if(change==='delete')store.delete(parent.id);
 else await new FileAttachments(files).prepare(parent.id,original.id,{mimeType:'text/plain'},()=>{});
 release();await running;
 const id=materialId('generated','parent');assert.equal(materials.get(id),undefined,'the old in-flight snapshot must not publish');
 assert.ok(store.db.prepare("SELECT 1 FROM execution_steps WHERE kind='material.organizer' AND state='stale'").get());
 await organizers.tick(200);
 if(change==='revision')assert.match(materials.read(id).text,/Generated current revision/);
 else if(change==='attachment')assert.equal(materials.get(id)!.memberCount,2);
 else assert.equal(materials.get(id),undefined);
 const operations=new Operations(store),operation=operations.page({kind:'material-organizer'}).items[0]!;
 assert.equal(operation.state,'succeeded','the current replacement, not its stale predecessor, defines task status');
 const detail=operations.detail(operation.id);
 assert.equal(detail.steps.filter(step=>step.current).length,1);
 assert.ok(detail.steps.some(step=>!step.current&&step.state==='stale'),'obsolete work remains in history');
});

test('restart repairs legacy organizer membership without rerunning successful or stale steps',async t=>{
 const {sources,organizers,store,materials}=fixture(t);
 await sources.upsert('generated',item('legacy'));
 await organizers.tick();
 await sources.upsert('generated',item('legacy','2','Generated replacement'));
 await organizers.tick();
 const operation=new Operations(store).page({kind:'material-organizer'}).items[0]!;
 await organizers.close();await organizers.executor.close();
 // Reproduce the old read model: every generation was counted as current.
 const old=store.db.prepare('SELECT id FROM execution_steps WHERE operation_id=? ORDER BY created_at,id LIMIT 1').get(operation.id)!;
 store.db.prepare("UPDATE execution_steps SET state='stale',error='input_changed' WHERE id=?").run(old.id);
 store.db.prepare("UPDATE execution_operation_steps SET slot='',generation='',active=1 WHERE operation_id=?").run(operation.id);
 store.db.prepare('DELETE FROM operation_generations WHERE operation_id=?').run(operation.id);
 assert.equal(new Operations(store).detail(operation.id).operation.state,'stale');
 const receipts=store.db.prepare('SELECT id,state,attempts,input FROM execution_steps ORDER BY id').all(),revision=materials.get(materialId('generated','legacy'))!.revision;
 const reopened=new Store(store.directory),currentMaterials=new MaterialStore(reopened),restarted=new MaterialOrganizerRuntime(reopened,currentMaterials);
 try{
  const detail=new Operations(reopened).detail(operation.id);
  assert.equal(detail.operation.state,'succeeded');assert.equal(detail.steps.filter(step=>step.current).length,1);
  assert.equal(detail.steps.find(step=>step.id===old.id)!.current,false);
  await restarted.tick();
  assert.deepEqual(reopened.db.prepare('SELECT id,state,attempts,input FROM execution_steps ORDER BY id').all(),receipts);
  assert.equal(currentMaterials.get(materialId('generated','legacy'))!.revision,revision);
 }finally{await restarted.close();await restarted.executor.close();reopened.close();}
});

test('a failed current organizer generation remains visible after its predecessor is superseded',async t=>{
 const {sources,organizers,store}=fixture(t);
 await sources.upsert('generated',item('failed-current'));await organizers.tick();
 const organizer=organizers.registry.get('mote.source-item')!,build=organizer.build;
 organizer.build=()=>{throw Error('Generated current publication failure');};
 try{
  await sources.upsert('generated',item('failed-current','2'));
  await assert.rejects(organizers.tick(),/Generated current publication failure/);
  const operations=new Operations(store),operation=operations.page({kind:'material-organizer'}).items[0]!,detail=operations.detail(operation.id);
  assert.equal(operation.state,'failed');assert.equal(detail.steps.filter(step=>step.current).length,1);
  assert.equal(detail.steps.find(step=>step.current)!.state,'failed');
  assert.ok(detail.steps.some(step=>!step.current&&step.state==='succeeded'));
 }finally{organizer.build=build;}
});
