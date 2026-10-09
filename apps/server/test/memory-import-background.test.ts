import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import {SourceStore} from '../src/sources.js';
import type {Config} from '../src/config.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';

// Real startup, HTTP preparation/confirmation, receipt ingestion and periodic
// publication/Memory workers. All source content and model responses are generated.
test('HTTP import of a thousand generated originals rolls through bounded background packages without planning',{timeout:260000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-background-import-'));
 const config:Config={dataDir:directory,token:'generated-background-import-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let extracts=0,reviews=0,planning=0,importId='',reviewBeforeImportComplete=false,releasePrefix!:()=>void,releaseTail!:()=>void;
 const prefixReviewed=new Promise<void>(resolve=>releasePrefix=resolve),priorCommitted=new Promise<void>(resolve=>releaseTail=resolve),upsert=SourceStore.prototype.upsert;
 // Pause the incoming stream after seven real receipts. The ordinary 5-second
 // workers must review this incomplete transport batch before input resumes.
 // Make the last receipt arrive after every earlier receipt has committed, so
 // its one-member tail is deterministic even when workers see varying prefixes.
 t.mock.method(SourceStore.prototype,'upsert',async function(this:SourceStore,...args:Parameters<SourceStore['upsert']>){if(args[1].externalId==='generated-7')await prefixReviewed;if(args[1].externalId==='generated-999')await priorCommitted;return upsert.apply(this,args);});
 const node=await buildApp(config,{backgroundWorker:true,prepareImport:async input=>{
  writeFileSync(join(input.workspace,'records.jsonl'),Array.from({length:1000},(_,index)=>JSON.stringify({item:{externalId:'generated-'+index,revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',title:'Generated reference '+index,text:'Generated reference '+index+' has no durable candidate.'},evidencePaths:input.inputPaths})).join('\n')+'\n');
  return {summary:'A thousand generated independent originals'};
 },agent:{configured:true,close:async()=>{},query:async input=>{
  const work=input.taskContext?.memoryWork as {members?:MemoryWorkMember[];catalog?:unknown[]}|undefined;
  if(work?.catalog){planning++;throw Error('Ordinary ready input must not call the planner');}
  assert.ok(work?.members?.length);assert.ok(work.members.length<=8);assert.ok(work.members.reduce((sum,member)=>sum+member.length,0)<=12000);
  assert.ok(work.members.every(member=>member.contextTime&&member.inputKey&&member.attributionContext));
  if(input.traceContext?.phase==='review'){reviews++;if(reviews===1){reviewBeforeImportComplete=node.imports.get(importId).status==='importing';releasePrefix();}}else extracts++;
  return {answer:generatedMemoryOutput(input),citations:[],trace:[],runId:'generated-background-'+extracts+'-'+reviews};
 }}});await node.app.ready();
 t.after(async()=>{releasePrefix();releaseTail();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token};
 const created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{files:[{name:'generated.custom',dataBase64:Buffer.from('Generated parser input').toString('base64')}]}});assert.equal(created.statusCode,202,created.body);
 const id=created.json().id;importId=id;
 for(let attempt=0;attempt<100;attempt++){if(node.imports.get(id).status==='awaiting_confirmation')break;await setTimeout(20);}
 assert.equal(node.imports.get(id).status,'awaiting_confirmation');
 const confirmed=await node.app.inject({method:'POST',url:`/api/imports/${id}/confirm`,headers});assert.equal(confirmed.statusCode,202,confirmed.body);
 const deadline=Date.now()+240000;
 while(Date.now()<deadline){

  const imported=node.imports.get(id),completed=Number(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n);
  if(completed===999)releaseTail();
  if(imported.status==='completed'&&completed===1000)break;
  await setTimeout(250);
 }
 assert.equal(node.imports.get(id).progress.imported,1000);
 const receipts=node.store.db.prepare('SELECT input_key,scope,job_id FROM memory_input_authorizations WHERE authorized=1').all();assert.equal(receipts.length,1000);assert.ok(receipts.every(receipt=>receipt.job_id),JSON.stringify({claimed:receipts.filter(receipt=>receipt.job_id).length,materials:node.store.db.prepare('SELECT count(*) n FROM material_heads').get(),requests:node.store.db.prepare('SELECT auto_authorized,error,count(*) n FROM material_memory_requests GROUP BY auto_authorized,error').all(),jobs:node.store.db.prepare("SELECT json_extract(json,'$.status') status,count(*) n FROM memory_jobs GROUP BY status").all(),checkpoints:node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get(),extracts,reviews}));
 const rows=node.store.db.prepare('SELECT id FROM memory_jobs').all(),jobs=rows.map(row=>node.memoryPipeline.get(String(row.id)));
 assert.equal(reviewBeforeImportComplete,true,'ready prefix is reviewed while the input stream is still importing');assert.ok(jobs.some(job=>job.workPackage?.inputs?.length===7)&&jobs.some(job=>job.workPackage?.inputs?.length===1),'partial prefix and trailing member finish without waiting for a full batch');assert.ok(jobs.some(job=>job.workPackage?.inputs?.length===8)&&jobs.length<1000,'ready arrivals are also packed into bulk work');assert.ok(jobs.every(job=>job.status==='completed'),JSON.stringify(jobs.filter(job=>job.status!=='completed').map(job=>({status:job.status,error:job.errorCode}))));
 const covered=jobs.flatMap(job=>job.batches.flatMap(batch=>batch.coverage??[]));assert.equal(covered.length,1000);assert.equal(new Set(covered.map(member=>member.key)).size,1000);assert.ok(covered.every(member=>member.state==='no_candidates'));
 const batches=jobs.flatMap(job=>job.batches);assert.equal(batches.length,jobs.length,'each bounded package completes one whole batch');assert.deepEqual({planning,extracts,reviews},{planning:0,extracts:batches.length,reviews:batches.length});
 assert.ok(node.materials.list({query:'reference'}).items.length>0);assert.equal(node.memories.list().length,0);
});
