import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {AssistantChangeFeed} from '../src/assistant-change-feed.js';
import {BatchProcessing} from '../src/batch-processing.js';
import {TaskRecords} from '../src/task-records.js';
import {materialId,MaterialStore} from '../src/materials.js';
import {sha256,Store,StoreError} from '../src/store.js';
import {SourceArchive} from '../src/source-archive.js';
import {BackgroundModelAuthorization} from '../src/background-model-authorization.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-changes-'));
 const config:Config={dataDir:directory,dataKey:'42'.repeat(32),contentEncryptionEnabled:true,token:'generated-change-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const build=()=>buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model request');},close:async()=>{}}});
 let node=await build(),now=1000;
 const open=()=>new AssistantChangeFeed(node.store,node.materials,node.modelAuthorization,ids=>{
  if(!node.featureServices.evidenceReader.contextDependenciesAllowed(ids))throw new StoreError('Evidence unavailable',409);
 },()=>now,10,30);
 let feed=open();await node.app.ready();
 const headers={authorization:'Bearer '+config.token,'x-mote-ingress-version':'2'};
 const createSource=async(id='generated-source')=>{const result=await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'}});assert.equal(result.statusCode,200,result.body);};
 const upsert=async(externalId:string,revision:string,deleted=false)=>{const result=await node.app.inject({method:'PUT',url:'/api/sources/generated-source/items',headers,payload:{externalId,revision,observedAt:`2026-10-0${revision}T00:00:00Z`,kind:'message',layer:'original',text:deleted?'':`Generated version ${revision}`,deleted}});assert.equal(result.statusCode,200,result.body);return result.json().id as string;};
 const command=(action:'on'|'off'|'stop')=>node.modelAuthorization.command({action,revision:node.modelAuthorization.view().revision,operationId:randomUUID()});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 return {get node(){return node;},get feed(){return feed;},headers,createSource,upsert,command,advance(ms:number){now+=ms;},async restart(){await node.app.close();node=await build();feed=open();await node.app.ready();}};
}

test('source intake survives lost wakeups and atomic task/cursor rollback and restart',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');const id=await f.upsert('one','1');
 const before=Number(f.feed.coverage().cursor);
 f.node.store.db.exec("CREATE TEMP TRIGGER generated_enqueue_failure BEFORE INSERT ON task_records WHEN new.kind='assistant.change' BEGIN SELECT RAISE(ABORT,'generated failure'); END");
 assert.throws(()=>f.feed.tick(),/generated failure/);
 assert.equal(Number(f.feed.coverage().cursor),before);
 assert.equal(f.node.store.db.prepare("SELECT count(*) AS n FROM task_records WHERE kind='assistant.change'").get()!.n,0);
 f.node.store.db.exec('DROP TRIGGER generated_enqueue_failure');
 f.feed.tick();f.advance(11);let ready=f.feed.ready();assert.equal(ready.length,1);assert.equal(ready[0].input.captureId,id);
 const taskId=ready[0].task.id;await f.restart();f.advance(1);f.feed.tick();ready=f.feed.ready();
 assert.equal(ready.length,1);assert.equal(ready[0].task.id,taskId);
 assert.equal(f.node.store.db.prepare("SELECT count(*) AS n FROM task_records WHERE kind='assistant.change'").get()!.n,1);
 assert.equal(f.feed.coverage().initial_captures,0);
});

test('consecutive source versions settle to the last input, with a bounded maximum wait and deletion priority',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');
 const ids:string[]=[];
 for(let n=1;n<=3;n++){ids.push(await f.upsert('document',String(n)));f.feed.tick();if(n<3)f.advance(8);}
 assert.equal(f.feed.ready().length,0);f.advance(10);let ready=f.feed.ready();assert.equal(ready.length,1);assert.equal(ready[0].input.captureId,ids[2]);
 assert.equal(f.node.store.db.prepare("SELECT count(*) AS n FROM task_records WHERE kind='assistant.change' AND state='waiting'").get()!.n,1);
 await f.upsert('deleted','1');f.feed.tick();await f.upsert('deleted','2',true);f.feed.tick();f.advance(50);
 assert.equal(f.feed.ready().filter(value=>value.input.captureId!==ids[2]).length,0);
 const tasks=new TaskRecords(f.node.store),old=ready[0].task;f.node.store.delete(ids[2]);assert.equal(tasks.get(old.id).state,'stale');
 assert.equal(f.feed.ready().length,0);
});

test('real K4 queue admits only the latest frozen root and failures do not block another source item',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');const seen:string[]=[];
 await f.node.batchProcessing.close();
 const answer=(input:QueryInput):QueryResult=>({answer:'Generated result',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]}});
 const batch=new BatchProcessing(f.node.store,f.node.executor,f.node.modelAuthorization,async input=>{const id=input.evidenceIds![0];seen.push(id);if(input.question==='fail')throw Error('Generated failure');return answer(input);},ids=>{if(ids.some(id=>!f.node.store.isCurrentEvidence(id)))throw new StoreError('Stale',409);},ids=>f.node.modelAuthorizationHost.assertEvidence(ids),()=>{},()=>undefined);
 t.after(()=>batch.close());
 const first=await f.upsert('failing','1');f.feed.tick();const second=await f.upsert('following','1');f.feed.tick();f.advance(11);
 const jobs=f.feed.ready();assert.equal(jobs.length,2);
 const submitted=jobs.map(({task,input})=>({captureId:input.captureId,job:f.feed.submit(task.id,{operationId:'generated-'+input.captureId,requestId:'generated-'+input.captureId,items:[{question:input.captureId===first?'fail':'follow',evidenceIds:[input.captureId!]}]},batch)}));
 await f.node.executor.drain(submitted.flatMap(({job})=>batch.progress(job.id).items.map(step=>step.id)));
 assert.deepEqual(new Set(seen),new Set([first,second]));
 assert.equal(batch.progress(submitted.find(entry=>entry.captureId===second)!.job.id).items[0].state,'succeeded');
 assert.equal(f.feed.ready().length,0);
});

test('continuous saves advance at the maximum wait even while the quiet interval keeps moving',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');let last='';
 for(let n=1;n<=3;n++){last=await f.upsert('frequent',String(n));f.feed.tick();f.advance(9);}
 assert.equal(f.feed.ready().length,0);f.advance(3);
 const ready=f.feed.ready();assert.equal(ready.length,1);assert.equal(ready[0].input.captureId,last);
});

test('enqueue and receipt claim roll back together, then survive restart without a second batch',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');const id=await f.upsert('atomic','1');f.feed.tick();f.advance(11);
 const ready=f.feed.ready()[0],request={operationId:'generated-atomic',requestId:'generated-atomic',items:[{question:'Inspect generated original',evidenceIds:[id]}]};
 f.node.store.db.exec("CREATE TEMP TRIGGER generated_batch_failure BEFORE UPDATE OF started_batch ON assistant_change_work BEGIN SELECT RAISE(ABORT,'generated batch failure'); END");
 assert.throws(()=>f.feed.submit(ready.task.id,request,f.node.batchProcessing),/generated batch failure/);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,0);
 assert.equal(f.feed.ready()[0].task.id,ready.task.id);
 f.node.store.db.exec('DROP TRIGGER generated_batch_failure');
 const batch=f.feed.submit(ready.task.id,request,f.node.batchProcessing);
 assert.equal(f.feed.submit(ready.task.id,request,f.node.batchProcessing).id,batch.id);
 assert.throws(()=>f.feed.submit(ready.task.id,{...request,items:[{...request.items[0],question:'Different input'}]},f.node.batchProcessing),{statusCode:409});
 await f.restart();f.feed.tick();
 assert.equal(f.feed.ready().length,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,1);
 assert.equal(f.node.store.db.prepare('SELECT started_batch FROM assistant_change_work').get()!.started_batch,batch.id);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,1);
});

test('coalesced ready originals claim one batch atomically and replay both work pointers without another receipt',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');
 const first=await f.upsert('group-one','1'),second=await f.upsert('group-two','1');f.feed.tick();f.advance(11);
 const ready=f.feed.ready();assert.equal(ready.length,2);
 const request={operationId:'generated-group',requestId:'generated-group',items:[{question:'Review the two generated originals together',evidenceIds:[first,second]}]};
 const context={evidenceIds:[],taskIds:[ready[1].task.id]};
 f.node.store.db.exec(`CREATE TEMP TRIGGER generated_group_failure BEFORE UPDATE OF started_batch ON assistant_change_work
  WHEN old.capture_id='${second}' BEGIN SELECT RAISE(ABORT,'generated group failure'); END`);
 assert.throws(()=>f.feed.submit(ready[0].task.id,request,f.node.batchProcessing,context),/generated group failure/);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,0);
 assert.equal(f.feed.ready().length,2);
 f.node.store.db.exec('DROP TRIGGER generated_group_failure');
 const batch=f.feed.submit(ready[0].task.id,request,f.node.batchProcessing,context);
 assert.equal(f.feed.submit(ready[0].task.id,request,f.node.batchProcessing,context).id,batch.id);
 assert.equal(f.feed.submit(ready[1].task.id,request,f.node.batchProcessing,{evidenceIds:[],taskIds:[ready[0].task.id]}).id,batch.id);
 assert.deepEqual(f.node.store.db.prepare('SELECT started_batch FROM assistant_change_work ORDER BY capture_id').all().map(row=>row.started_batch),[batch.id,batch.id]);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,2);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,1);
 await f.restart();f.feed.tick();assert.equal(f.feed.ready().length,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,1);
});

test('a real uploaded file waits for extraction and resumes the original receipt after a lost wakeup',async t=>{
 const f=await fixture(t);f.command('on');
 f.node.sources.register({id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'generated-device',platform:'import',retention:'archive'});
 const bytes=Buffer.from('Generated file body: the final section is present.'),item={externalId:'generated.txt',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated file',kind:'file' as const,layer:'original' as const,text:'',mimeType:'text/plain',deleted:false};
 const upload=f.node.files.begin({sourceId:'generated-files',item,sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 f.node.files.part(upload.uploadId,0,bytes,()=>{});const received=await f.node.files.commit(upload.uploadId,()=>{});
 f.feed.tick();f.advance(20);assert.equal(f.feed.ready().length,0);
 await f.node.materialOrganizer.tick(100);f.feed.tick();
 const pending=f.node.store.db.prepare('SELECT task_id FROM assistant_change_work WHERE capture_id=?').get(received.id)!;
 const pendingTask=new TaskRecords(f.node.store).get(String(pending.task_id));
 assert.equal(new TaskRecords(f.node.store).input<{readiness:string}>(pendingTask.id,pendingTask.revision,()=>{}).readiness,'pending');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,0);
 const settings={...f.node.processing.view().settings,enabled:true,summarize:false};
 await f.node.processing.save({revision:f.node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.node.processing.runtime.registry)});
 await f.node.processing.tick();
 await f.node.materialOrganizer.tick(100);
 // A lost callback does not matter: poll the committed feed after processing.
 f.feed.tick();const ready=f.feed.ready();assert.equal(ready.length,1,JSON.stringify({job:f.node.files.detail(received.id).job,material:f.node.materials.get(materialId('generated-files','generated.txt')),pending:f.node.store.db.prepare('SELECT * FROM assistant_change_work WHERE capture_id=?').get(received.id)}));
 assert.equal(ready[0].input.root,'capture:'+received.id);
 assert.equal(ready[0].input.captureId,received.id);assert.equal(ready[0].input.readiness,'ready');
 assert.equal(ready[0].input.material?.ref,f.node.materials.get(materialId('generated-files','generated.txt'))?.ref);
 assert.match(f.node.materials.read(ready[0].input.material!.ref).text,/final section is present/);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_receipts WHERE identity=?").get('capture:'+received.id)!.n,1);
 await f.node.batchProcessing.close();let consumed='';
 const batch=new BatchProcessing(f.node.store,f.node.executor,f.node.modelAuthorization,async input=>{
  assert.deepEqual(input.evidenceIds,[received.id]);consumed=f.node.materials.read(ready[0].input.material!.ref).text;
  return {answer:'Generated result',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[received.id]}};
 },ids=>{if(ids.some(id=>!f.node.store.isCurrentEvidence(id)))throw new StoreError('Stale',409);},ids=>f.node.modelAuthorizationHost.assertEvidence(ids),()=>{},()=>undefined);
 t.after(()=>batch.close());
 const submitted=f.feed.submit(ready[0].task.id,{operationId:'generated-file-understanding',requestId:'generated-file-understanding',items:[{question:'Inspect the generated file',evidenceIds:[received.id]}]},batch);
 await f.node.executor.drain(batch.progress(submitted.id).items.map(step=>step.id));
 assert.match(consumed,/final section is present/);assert.equal(batch.progress(submitted.id).items[0].state,'succeeded');
});

test('derived publications do not mint new roots, and explicit feedback is scoped and rejects a late card update',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');const id=await f.upsert('feedback','1');f.feed.tick();f.advance(11);
 const task=f.feed.ready()[0].task;const cards=f.node.featureServices.assistantCards,cardId=randomUUID(),scope={kind:'selection' as const,evidenceIds:[id]};
 const publication={id:cardId,kind:'suggestion' as const,matterId:null,version:'generated-v1',state:'open' as const,title:'Generated title',body:'Generated initial result',evidence:[{id,quote:'Generated version 1'}],evidenceDependencies:{version:1 as const,complete:true as const,ids:[id]}};
 const card=cards.publish(publication,undefined,scope,()=>{});
 const corrected=cards.feedback(cardId,{expectedRevision:card.revision,action:'correct',note:'Generated owner correction'},scope);
 assert.throws(()=>cards.publish({...publication,version:'late',body:'Late result'},card.revision,scope,()=>{}),{statusCode:409});
 assert.equal(f.node.store.db.prepare('SELECT needs_review FROM assistant_change_work WHERE task_id=?').get(task.id)!.needs_review,1);
 assert.equal(f.feed.reviews()[0].task.id,task.id);
 assert.equal(f.feed.ready().length,0);
 const receipts=Number(f.node.store.db.prepare('SELECT count(*) n FROM background_model_receipts').get()!.n);
 f.node.store.archive.save(randomUUID(),'generated-summary','generated-v1',{kind:'summary',text:'Generated derived summary',metadata:{}},[{id,fingerprint:f.node.store.archive.fingerprint(id)!}],'generated.processor','1','generated-config');
 f.feed.tick();const feedback=f.feed.feedback();assert.equal(feedback.length,1);assert.deepEqual(feedback[0].input.scope,scope);
 assert.equal(feedback[0].input.cardRevision,corrected.revision);
 assert.equal(f.node.store.db.prepare('SELECT needs_review FROM assistant_change_work WHERE task_id=?').get(task.id)!.needs_review,1);
 assert.equal(Number(f.node.store.db.prepare('SELECT count(*) n FROM background_model_receipts').get()!.n),receipts);
 await f.node.materialOrganizer.tick(100);f.feed.tick();f.feed.tick();
 assert.equal(f.feed.feedback().length,1);
 assert.equal(Number(f.node.store.db.prepare('SELECT count(*) n FROM background_model_receipts').get()!.n),receipts);
 f.node.store.delete(id);assert.equal(f.feed.feedback().length,0);
});

test('archive checkpoint intake reaches K4 through the current Material evidence reader',async t=>{
 const f=await fixture(t);f.command('on');
 f.node.sources.register({id:'generated-coding',kind:'coding-agent',name:'Generated coding',deviceId:'generated-device',platform:'macos'});
 const at='2026-10-01T00:00:00Z';
 await f.node.sources.upsert('generated-coding',{externalId:'generated-event',revision:'1',observedAt:at,kind:'message',layer:'original',text:'Generated coding requirement',
  document:{recordedAt:at,timeBasis:'recorded',contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'generated-event',role:'user',attribution:'human',part:0,parts:1}}});
 f.feed.tick();f.advance(11);assert.equal(f.feed.ready().length,0);
 await f.node.sourcePipelines.tick();f.feed.tick();const ready=f.feed.ready();assert.equal(ready.length,1);
 assert.ok(ready[0].input.root.startsWith('source:'));assert.ok(ready[0].input.material);assert.ok(ready[0].input.evidenceIds.length);
 assert.match(f.node.materials.read(ready[0].input.material!.ref).text,/Generated coding requirement/);
 await f.node.batchProcessing.close();let calls=0;
 const batch=new BatchProcessing(f.node.store,f.node.executor,f.node.modelAuthorization,async input=>{calls++;return {answer:'Generated result',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.evidenceIds??[])]}};},ids=>{
  if(ids.some(id=>!f.node.featureServices.evidenceReader.memories.isCurrentEvidence(id)))throw new StoreError('Evidence changed',409);
 },ids=>f.node.modelAuthorizationHost.assertEvidence(ids),()=>{},()=>undefined,()=>1,false,f.node.featureServices.evidenceReader.memories);
 t.after(()=>batch.close());
 const job=f.feed.submit(ready[0].task.id,{operationId:'generated-archive',requestId:'generated-archive',items:[{question:'Inspect generated archive',evidenceIds:ready[0].input.evidenceIds}]},batch);
 await f.node.executor.drain(batch.progress(job.id).items.map(step=>step.id));assert.equal(calls,1);assert.equal(batch.progress(job.id).items[0].state,'succeeded');
});

test('off withholds new work, and stop cancels admitted K4 work without re-admission',async t=>{
 const f=await fixture(t);await f.createSource();const id=await f.upsert('off','1');f.feed.tick();f.advance(11);
 assert.equal(f.feed.ready().length,0);f.command('on');const task=f.feed.ready()[0].task;
 const job=f.feed.submit(task.id,{operationId:'generated-stop',requestId:'generated-stop',items:[{question:'Inspect generated input',evidenceIds:[id]}]},f.node.batchProcessing);
 f.command('stop');assert.equal(f.node.batchProcessing.progress(job.id).task.state,'cancelled');
 f.command('on');f.feed.tick();assert.equal(f.feed.ready().length,0);
});

test('an unavailable original is retried independently without stopping the global cursor',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');const first=await f.upsert('deferred','1'),second=await f.upsert('independent','1');let blocked=true;
 const feed=new AssistantChangeFeed(f.node.store,f.node.materials,f.node.modelAuthorization,ids=>{
  if(blocked&&ids.includes(first))throw new StoreError('Generated unavailable source',409);
  if(ids.some(id=>!f.node.store.isCurrentEvidence(id)))throw new StoreError('Stale',409);
 },()=>1000,0,0);
 feed.tick();assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_change_deferred').get()!.n,1);
 assert.deepEqual(feed.ready().map(item=>item.input.captureId),[second]);
 blocked=false;feed.tick();assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_change_deferred').get()!.n,0);
 assert.deepEqual(new Set(feed.ready().map(item=>item.input.captureId)),new Set([first,second]));
});

test('deleting the original while K4 runs prevents a late result from publishing',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');const id=await f.upsert('late','1');f.feed.tick();f.advance(11);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 await f.node.batchProcessing.close();
 const batch=new BatchProcessing(f.node.store,f.node.executor,f.node.modelAuthorization,async input=>{entered();await gate;return {answer:'Late generated result',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.evidenceIds??[])]}};},ids=>{
  if(ids.some(value=>!f.node.store.isCurrentEvidence(value)))throw new StoreError('Deleted',409);
 },ids=>f.node.modelAuthorizationHost.assertEvidence(ids),()=>{},()=>undefined);
 t.after(async()=>{release();await batch.close();});
 const task=f.feed.ready()[0].task,job=f.feed.submit(task.id,{operationId:'generated-late',requestId:'generated-late',items:[{question:'Inspect generated input',evidenceIds:[id]}]},batch);
 const steps=batch.progress(job.id).items.map(step=>step.id),running=f.node.executor.drain(steps);await started;
 f.node.store.delete(id);release();await running;
 assert.equal(new TaskRecords(f.node.store).get(job.id).state,'stale');
 assert.throws(()=>batch.result(job.id),{statusCode:409});assert.equal(f.feed.ready().length,0);
});

test('a new archive checkpoint invalidates a running batch before its Material is rebuilt',async t=>{
 const f=await fixture(t);f.command('on');
 f.node.sources.register({id:'generated-coding-race',kind:'coding-agent',name:'Generated coding',deviceId:'generated-device',platform:'macos'});
 const event=(externalId:string,at:string)=>({externalId,revision:'1',observedAt:at,kind:'message' as const,layer:'original' as const,text:'Generated '+externalId,
  document:{recordedAt:at,timeBasis:'recorded' as const,contentRole:'transcript' as const,coding:{version:1 as const,provider:'codex' as const,projectKey:'generated-project',sessionId:'generated-session',eventId:externalId,role:'user' as const,attribution:'human' as const,part:0,parts:1}}});
 await f.node.sources.upsert('generated-coding-race',event('first','2026-10-01T00:00:00Z'));f.feed.tick();await f.node.sourcePipelines.tick();f.feed.tick();f.advance(11);
 const ready=f.feed.ready()[0];assert.ok(ready);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 await f.node.batchProcessing.close();
 const batch=new BatchProcessing(f.node.store,f.node.executor,f.node.modelAuthorization,async input=>{entered();await gate;return {answer:'Late archive result',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.evidenceIds??[])]}};},ids=>{
  if(ids.some(id=>!f.node.featureServices.evidenceReader.memories.isCurrentEvidence(id)))throw new StoreError('Evidence changed',409);
 },ids=>f.node.modelAuthorizationHost.assertEvidence(ids),()=>{},()=>undefined,()=>1,false,f.node.featureServices.evidenceReader.memories);
 t.after(async()=>{release();await batch.close();});
 const job=f.feed.submit(ready.task.id,{operationId:'generated-archive-race',requestId:'generated-archive-race',items:[{question:'Inspect generated archive',evidenceIds:ready.input.evidenceIds}]},batch);
 const running=f.node.executor.drain(batch.progress(job.id).items.map(step=>step.id));await started;
 await f.node.sources.upsert('generated-coding-race',event('second','2026-10-02T00:00:00Z'));
 assert.equal(new TaskRecords(f.node.store).get(job.id).state,'stale');release();await running;
 assert.throws(()=>batch.result(job.id),{statusCode:409});
 await f.node.sourcePipelines.tick();f.feed.tick();f.advance(11);assert.equal(f.feed.ready().length,1);
});

test('an archive append with no new model-visible Material does not create fresh analysis',async t=>{
 const f=await fixture(t);f.command('on');
 f.node.sources.register({id:'generated-coding-hidden',kind:'coding-agent',name:'Generated coding',deviceId:'generated-device',platform:'macos'});
 const at='2026-10-01T00:00:00Z',event=(id:string,role:'user'|'tool_result')=>({externalId:id,revision:'1',observedAt:at,kind:'message' as const,layer:'original' as const,text:'Generated '+id,
  document:{recordedAt:at,timeBasis:'recorded' as const,contentRole:'transcript' as const,coding:{version:1 as const,provider:'codex' as const,projectKey:'generated-project',sessionId:'generated-session',eventId:id,role,attribution:role==='user'?'human' as const:'unknown' as const,part:0,parts:1}}});
 await f.node.sources.upsert('generated-coding-hidden',event('visible','user'));f.feed.tick();await f.node.sourcePipelines.tick();f.feed.tick();f.advance(11);
 const first=f.feed.ready()[0];assert.ok(first);const priorRef=first.input.material!.ref;
 await f.node.sources.upsert('generated-coding-hidden',event('tool-only','tool_result'));await f.node.sourcePipelines.tick();f.feed.tick();f.advance(11);
 assert.equal(f.node.materials.get(priorRef.split('@')[0])!.ref,priorRef);
 assert.equal(f.feed.ready().length,0);assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,0);
});

test('a source item declared derived is not an automatic assistant input',async t=>{
 const f=await fixture(t);await f.createSource();f.command('on');
 const response=await f.node.app.inject({method:'PUT',url:'/api/sources/generated-source/items',headers:f.headers,payload:{externalId:'derived',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'derived',text:'Generated interpretation'}});
 assert.equal(response.statusCode,200,response.body);f.feed.tick();f.advance(20);
 assert.equal(f.feed.ready().length,0);assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.change'").get()!.n,0);
});

test('forgetting an archive before organization clears its pending input and change identities',async t=>{
 const f=await fixture(t);f.command('on');f.node.sources.register({id:'generated-forget-archive',kind:'coding-agent',name:'Generated coding',deviceId:'generated-device',platform:'macos'});
 const at='2026-10-01T00:00:00Z';
 await f.node.sources.upsert('generated-forget-archive',{externalId:'generated-event',revision:'1',observedAt:at,kind:'message',layer:'original',text:'Generated private input',
  document:{recordedAt:at,timeBasis:'recorded',contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'generated-event',role:'user',attribution:'human',part:0,parts:1}}});
 f.feed.tick();const taskId=String(f.node.store.db.prepare('SELECT task_id FROM assistant_change_work WHERE source_id=?').get('generated-forget-archive')!.task_id);
 f.node.sourcePipelines.forget('generated-forget-archive');
 assert.equal(new TaskRecords(f.node.store).get(taskId).state,'stale');
 assert.equal(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(taskId)!.input_json,null);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_change_log WHERE source_id=?').get('generated-forget-archive')!.n,0);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_change_work WHERE source_id=?').get('generated-forget-archive')!.n,0);
});

test('initial retained history records coverage silently without manufacturing receipt eligibility',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-history-')),store=new Store(directory);
 const id=randomUUID();await store.ingest({id,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2020-01-01T00:00:00Z',durationMs:0,ocrText:'Generated old note'});
 const materials=new MaterialStore(store);
 for(const state of ['complete','pending'] as const){
  const sourceId='generated-history',externalId=state;
  materials.publish({id:materialId(sourceId,externalId),kind:'mote.note',schemaVersion:1,title:'Generated historical note',origin:{sourceId,externalId},
   members:[{id,kind:'capture',ref:'capture:'+id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated old note',memberIds:[id]}],
   coverage:{state},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 }
 const engine=new ExecutionEngine(store);new SourceArchive(store);
 const authority=new BackgroundModelAuthorization(store,()=>[]),feed=new AssistantChangeFeed(store,materials,authority,()=>{},()=>1000,0,0);
 t.after(async()=>{authority.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 authority.command({action:'on',revision:authority.view().revision,operationId:randomUUID()});feed.tick();
 assert.equal(feed.coverage().initial_captures,1);assert.equal(feed.coverage().initial_materials,2);
 assert.equal(feed.coverage().initial_complete,1);assert.equal(feed.coverage().initial_pending,1);assert.equal(feed.coverage().initial_partial,0);assert.equal(feed.ready().length,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM background_model_receipts').get()!.n,0);
 assert.equal(store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.change'").get()!.n,0);
});

test('source exclusion withholds its original and re-inclusion makes it eligible without another receipt',async t=>{
 const f=await fixture(t);await f.createSource();await f.createSource('generated-other');f.command('on');
 const excluded=await f.upsert('excluded','1');
 const response=await f.node.app.inject({method:'PUT',url:'/api/sources/generated-other/items',headers:f.headers,payload:{externalId:'allowed',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated allowed'}});
 assert.equal(response.statusCode,200,response.body);const allowed=response.json().id as string;
 const exclude=(excludedSourceIds:string[])=>f.node.modelAuthorization.command({action:'exclude',revision:f.node.modelAuthorization.view().revision,operationId:randomUUID(),excludedSourceIds});
 exclude(['generated-source']);f.feed.tick();f.advance(11);assert.deepEqual(f.feed.ready().map(item=>item.input.captureId),[allowed]);
 const receipts=Number(f.node.store.db.prepare('SELECT count(*) n FROM background_model_receipts').get()!.n);
 exclude([]);assert.deepEqual(new Set(f.feed.ready().map(item=>item.input.captureId)),new Set([excluded,allowed]));
 assert.equal(Number(f.node.store.db.prepare('SELECT count(*) n FROM background_model_receipts').get()!.n),receipts);
});
