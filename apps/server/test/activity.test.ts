import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {Operations} from '../src/operations.js';
import {ActivityProjection,registerActivity,type ActivityDelegationReader} from '../src/activity.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import type {MemoryJob,MemoryBatch} from '../src/memory-pipeline.js';
function fixture(t:import('node:test').TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-work-activity-')),store=new Store(directory),engine=new ExecutionEngine(store);engine.register({kind:'fixture',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});t.after(async()=>{await engine.close();store.close();rmSync(directory,{force:true,recursive:true});});return {store,engine,activity:new ActivityProjection(store,new Operations(store))};}
const at='2026-09-20T10:00:00.000Z';
function insertJob(store:Store,job:Partial<MemoryJob>&Pick<MemoryJob,'id'|'evidenceIds'>){const value={createdAt:at,updatedAt:at,status:'running',memoryIds:[],materialInputs:[],materialRefs:{},...job};store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(value.id,at,JSON.stringify(value));return value;}
function insertBatch(store:Store,jobId:string,batch:Partial<MemoryBatch>&Pick<MemoryBatch,'id'|'evidenceRanges'>){const value={index:0,status:'pending',memoryIds:[],attempts:0,...batch};store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run(value.id,jobId,value.index,JSON.stringify(value));return value;}
test('formal material receipts count one record across synthetic evidence, partial ranges, scopes and replanning',t=>{
 const {store,activity}=fixture(t),materials=new MaterialStore(store),work=new MaterialMemoryWork(store,materials);
 new SourceStore(store).register({id:'generated-source',name:'Generated diaries',kind:'custom',deviceId:'fixture',platform:'import'});
 const draft:MaterialDraft={id:materialId('generated-source','one'),kind:'mote.file',schemaVersion:1,title:'Generated diary',origin:{sourceId:'generated-source',externalId:'one'},members:[{id:'original',kind:'archive',ref:'archive:generated'}],blocks:[{id:'first',kind:'text',format:'plain',text:'Generated PRIVATE ORIGINAL first span',memberIds:['original']},{id:'second',kind:'text',format:'plain',text:'Generated PRIVATE ORIGINAL second span',memberIds:['original']}],coverage:{state:'complete'},artifacts:[{key:'body',state:'ready'}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
 const material=materials.publish(draft),pin=materials.input(material.ref,['body'])!,refs=pin.evidenceIds;
 store.db.exec('BEGIN');work.inputs.receive({sourceId:'generated-source',inputKey:'raw-one',scope:'first'});work.inputs.receive({sourceId:'generated-source',inputKey:'raw-one',scope:'second'});work.inputs.receive({sourceId:'generated-source',inputKey:'not-yet-assigned',scope:'first'});store.db.exec('COMMIT');
 work.observe(material.id,['body'],{inputKey:'raw-one',change:'source'});
 const job=insertJob(store,{id:'generated-job',evidenceIds:refs,materialInputs:[pin],automaticGrant:{sourceId:'generated-source',inputKey:'raw-one',scope:'first'}});
 store.db.prepare('UPDATE material_memory_requests SET job_id=? WHERE material_id=?').run(job.id,material.id);
 const parent=insertBatch(store,job.id,{id:'parent',status:'completed',evidenceRanges:refs.map(id=>({id,offset:0,length:10})),supersededBy:['first-leaf','second-leaf'],coverage:refs.map((id,index)=>({id,key:String(index),offset:0,length:10,fingerprint:pin.fingerprint,state:'needs_context',memoryIds:[]}))});
 insertBatch(store,job.id,{id:'first-leaf',status:'completed',evidenceRanges:[{id:refs[0],offset:0,length:10}],coverage:[{id:refs[0],key:'first',offset:0,length:10,fingerprint:pin.fingerprint,state:'checked',memoryIds:[]}]});
 const second=insertBatch(store,job.id,{id:'second-leaf',index:1,status:'pending',evidenceRanges:[{id:refs[1],offset:0,length:10}],coverage:[{id:refs[1],key:'second',offset:0,length:10,fingerprint:pin.fingerprint,state:'pending',memoryIds:[]}]});
 let projection=activity.detail('memory-source:generated-source');assert.deepEqual(projection.progress,{mode:'determinate',unit:'records',total:2,completed:0,failed:0,needsInput:0,excluded:0});assert.equal(projection.branches.length,2);assert(!projection.branches.some(branch=>branch.id===parent.id));assert.doesNotMatch(JSON.stringify(projection),/PRIVATE ORIGINAL/);
 second.status='completed';second.coverage![0].state='no_candidates';store.db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(JSON.stringify(second),second.id);store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','completed') WHERE id=?").run(job.id);
 projection=activity.detail('memory-source:generated-source');assert.equal(projection.progress.mode==='determinate'&&projection.progress.completed,1,'all leaf spans are required and no-candidate review counts');assert.equal(projection.state,'waiting','unassigned input remains unfinished');assert.equal(activity.page().items.filter(item=>item.kind==='memory').length,1);
 store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','invalidated') WHERE id=?").run(second.id);const invalidated=activity.detail('memory-source:generated-source');assert.equal(invalidated.progress.mode==='determinate'&&invalidated.progress.completed,0,'stale batch state overrides an old checked receipt');assert.equal(invalidated.progress.mode==='determinate'&&invalidated.progress.failed,1);
 const page=activity.detail('memory-source:generated-source',0,1);assert.equal(page.branches.length,1);assert.equal(page.branchesNextCursor,1);
});
test('cross-source model work keeps both manifests and never uses step counts as item counts',t=>{
 const {store,activity}=fixture(t);new SourceStore(store).register({id:'one',name:'First generated',kind:'custom',deviceId:'fixture',platform:'import'});new SourceStore(store).register({id:'two',name:'Second generated',kind:'custom',deviceId:'fixture',platform:'import'});
 const inputs=new MaterialMemoryWork(store,new MaterialStore(store)).inputs;store.db.exec('BEGIN');for(const sourceId of ['one','two'])inputs.receive({sourceId,inputKey:'same-key'});store.db.exec('COMMIT');
 const refs=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];const pin=refs.map((ref,index)=>({materialId:'material-'+index,fingerprint:'a'.repeat(64),evidenceIds:[ref],required:['body']}));
 const job=insertJob(store,{id:'mixed',evidenceIds:refs,materialInputs:pin,automaticGrants:['one','two'].map(sourceId=>({sourceId,inputKey:'same-key',scope:'memory.default'})),workPackage:{id:'mixed',goal:'Read both sources',instruction:'Preserve sources',inputs:pin.map((value,index)=>({materialId:value.materialId,ref:'material-ref-'+index,sourceId:index?'two':'one',inputKey:'same-key',scope:'memory.default',contextTime:at,fingerprint:value.fingerprint}))}});
 store.db.exec('BEGIN');inputs.claimMany(job.automaticGrants!,job.id);store.db.exec('COMMIT');
 insertBatch(store,job.id,{id:'leaf',status:'completed',evidenceRanges:refs.map(id=>({id,offset:0,length:10}))});const grouped=activity.page().items.find(item=>item.kind==='memory')!;assert.match(grouped.goal,/First generated.*Second generated/);assert.equal(grouped.progress.mode==='determinate'&&grouped.progress.total,2);assert.equal(grouped.progress.mode==='determinate'&&grouped.progress.completed,2);
});
test('query stages and delegated branches come from host fields, with read-only bounded owner routes',async t=>{
 const {store,engine}=fixture(t);engine.enqueue('query:generated','fixture',{}, {initial:{state:'running',attempts:1,availableAt:0}});
 store.db.exec('CREATE TABLE query_runs(id TEXT PRIMARY KEY,request_hash TEXT,json TEXT)');store.db.prepare('INSERT INTO query_runs VALUES(?,?,?)').run('generated','fixture',JSON.stringify({id:'generated',status:'running',events:[{stage:'tool',phase:'completed',tool:'search_context',count:7,at},{stage:'validating',at}]}));
 const delegation:ActivityDelegationReader={list:()=>[{id:'query:generated'}],get:id=>({id,operationId:'query:generated',goal:'Generated open-ended investigation',status:'running',createdAt:at,updatedAt:at,units:[{id:'branch',title:'Inspect generated decisions',status:'succeeded',artifactId:'artifact',stepId:'fixture-step'}],events:[{id:1,type:'branch_completed',unitId:'branch',at,message:'Generated branch finished'}]}),artifactMetadata:()=>[{id:'artifact',summary:'Generated public result',unitId:'branch'}]};
 const activity=new ActivityProjection(store,new Operations(store),{delegation}),detail=activity.detail('query:generated');assert.deepEqual(detail.progress,{mode:'semantic',stage:'checking',returnedItems:7,completedBranches:1,totalBranches:1});assert.equal(detail.events[0].type,'branch.completed');assert.equal(detail.branches[0].state,'completed');assert(!('percentage' in detail.progress));
 const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error.name==='ZodError'?400:(error as {statusCode?:number}).statusCode??500).send({error:error.message}));t.after(()=>app.close());registerActivity(app,activity,req=>req.headers.authorization==='Bearer collector');
 for(const url of ['/api/work-activity','/api/work-activity/query%3Agenerated']){assert.equal((await app.inject({url})).statusCode,200);assert.equal((await app.inject({url,headers:{authorization:'Bearer collector'}})).statusCode,403);assert.equal((await app.inject({url,method:'POST'})).statusCode,404);}
 assert.equal((await app.inject({url:'/api/work-activity?limit=101'})).statusCode,400);
});

test('an import Memory goal cannot count unrelated receipts or cross-source links from another import',async t=>{
 const {store,activity}=fixture(t),inputs=new MaterialMemoryWork(store,new MaterialStore(store)).inputs,sources=new SourceStore(store);
 for(const id of ['shared-source','unrelated-source'])sources.register({id,name:id,kind:'custom',deviceId:'fixture',platform:'import'});
 const ref=(await sources.upsert('shared-source',{externalId:'imported-one',revision:'1',observedAt:at,kind:'file',layer:'snapshot',text:'Generated import manifest fixture'})).id;
 store.db.exec('BEGIN');inputs.receive({sourceId:'shared-source',inputKey:'imported-one',captureId:ref});inputs.receive({sourceId:'shared-source',inputKey:'other-import'});inputs.receive({sourceId:'unrelated-source',inputKey:'linked-elsewhere'});store.db.exec('COMMIT');
 store.db.exec('CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY,created_at TEXT,updated_at TEXT,json TEXT)');
 store.db.prepare('INSERT INTO import_jobs VALUES(?,?,?,?)').run('selected-import',at,at,JSON.stringify({id:'selected-import',name:'Selected generated import',captureIds:[ref]}));
 const job=insertJob(store,{id:'selected-job',importJobId:'selected-import',status:'completed',evidenceIds:[ref],automaticGrant:{sourceId:'shared-source',inputKey:'imported-one',scope:'memory.default'}});
 store.db.exec('BEGIN');inputs.claim('shared-source','imported-one',job.id);store.db.exec('COMMIT');insertBatch(store,job.id,{id:'import-leaf',status:'completed',evidenceRanges:[{id:ref,offset:0,length:10}]});
 insertJob(store,{id:'unrelated-cross-source',status:'queued',evidenceIds:[],automaticGrants:[{sourceId:'shared-source',inputKey:'other-import',scope:'memory.default'},{sourceId:'unrelated-source',inputKey:'linked-elsewhere',scope:'memory.default'}]});
 const projection=activity.detail('memory-import:selected-import');assert.match(projection.goal,/Selected generated import/);assert.equal(projection.state,'completed');assert.deepEqual(projection.progress,{mode:'determinate',unit:'records',total:1,completed:1,failed:0,needsInput:0,excluded:0});assert.equal(projection.branches.length,1);const card=activity.page().items.find(item=>item.id===projection.id)!;assert.deepEqual(card.progress,projection.progress);assert.equal(card.state,projection.state);
});

test('Activity pagination hydrates only selected public goals in a thousand-job history',t=>{
 const {store,activity}=fixture(t),ref='00000000-0000-4000-8000-000000000051';
 store.db.exec('BEGIN');for(let index=0;index<1000;index++){
  const updatedAt=new Date(Date.parse(at)+index*1000).toISOString(),id='history-'+String(index).padStart(4,'0');
  insertJob(store,{id,status:'completed',updatedAt,evidenceIds:[ref],workPackage:{id,goal:'Generated goal '+index,instruction:'Generated private worker payload '.repeat(50)}});
  insertBatch(store,id,{id:'leaf-'+id,status:'completed',evidenceRanges:[{id:ref,offset:0,length:10}]});
 }store.db.exec('COMMIT');
 let payloadRows=0;const db=store.db as any,prepare=db.prepare.bind(db);
 db.prepare=(sql:string)=>{const statement=prepare(sql);if(/^SELECT json FROM memory_(jobs|batches)\b/.test(sql)){const all=statement.all.bind(statement);statement.all=(...args:any[])=>{const rows=all(...args);payloadRows+=rows.length;return rows;};}return statement;};
 t.after(()=>{db.prepare=prepare;});
 const first=activity.page({state:'completed',limit:5});assert.equal(first.items.length,5);assert.equal(first.items[0].id,'memory:history-0999');assert.equal(first.nextCursor,5);assert.equal(payloadRows,0,'list cards summarize normalized metadata without loading job or batch payloads');assert.doesNotMatch(JSON.stringify(first),/private worker payload/);
 payloadRows=0;const second=activity.page({state:'completed',cursor:first.nextCursor!,limit:5});assert.equal(second.items[0].id,'memory:history-0994');assert.equal(payloadRows,0);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,10);
 store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','invalidated') WHERE id='leaf-history-0999'").run();
 const attention=activity.page({state:'attention',limit:5});assert.equal(attention.items[0].id,'memory:history-0999');assert.equal(attention.items[0].state,'stale','incremental metadata responds to product invalidation');
 store.logicalBytes();assert.ok(Number(store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='activity_memory_jobs'").get()!.bytes)>0);
});

 test('a selected source with a thousand completed jobs reads no private job or batch payloads for its list card',t=>{
 const {store,activity}=fixture(t);new SourceStore(store).register({id:'same-source',name:'Generated large source',kind:'custom',deviceId:'fixture',platform:'import'});
 store.db.exec('BEGIN');for(let index=0;index<1000;index++){
 const id='same-history-'+index,ref='00000000-0000-4000-8000-'+String(index).padStart(12,'0');insertJob(store,{id,status:'completed',evidenceIds:[ref],automaticGrant:{sourceId:'same-source',inputKey:'item-'+index,scope:'memory.default'}});insertBatch(store,id,{id:'leaf-'+id,status:'completed',evidenceRanges:[{id:ref,offset:0,length:10}]});}store.db.exec('COMMIT');
 let payloadRows=0;const db=store.db as any,prepare=db.prepare.bind(db);db.prepare=(sql:string)=>{const statement=prepare(sql);if(/^SELECT json FROM memory_(jobs|batches)\b/.test(sql)){const all=statement.all.bind(statement);statement.all=(...args:any[])=>{const rows=all(...args);payloadRows+=rows.length;return rows;};}return statement;};t.after(()=>{db.prepare=prepare;});
 const page=activity.page({limit:5}),card=page.items.find(item=>item.id==='memory-source:same-source')!;assert.deepEqual(card.progress,{mode:'determinate',unit:'records',total:1000,completed:1000,failed:0,needsInput:0,excluded:0});assert.equal(card.branchCounts?.total,1000);assert.equal(card.evidence.count,1000);assert.equal(card.technical.operationIds.length,100);assert.equal(payloadRows,0,'source history is aggregated in bounded metadata queries');
 });
