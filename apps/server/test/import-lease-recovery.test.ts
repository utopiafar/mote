import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {SourceStore} from '../src/sources.js';

for(const expireAfter of [1,3])test(`an authorized import resumes an expired commit lease after original ${expireAfter} without another confirmation`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-import-lease-'));
 const config:Config={dataDir:directory,token:'generated-import-lease-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let release!:()=>void,entered!:()=>void,parses=0,expired=false,importId='';const gate=new Promise<void>(resolve=>release=resolve),preparing=new Promise<void>(resolve=>entered=resolve),written:string[]=[];
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('No model is authorized by this fixture');}},prepareImport:async input=>{
  parses++;entered();await gate;writeFileSync(join(input.workspace,'records.jsonl'),Array.from({length:3},(_,index)=>JSON.stringify({item:{externalId:'generated-'+(index+1),revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated lease recovery evidence '+(index+1)},evidencePaths:input.inputPaths})).join('\n')+'\n');return {summary:'Three generated originals'};
 }});await node.app.ready();
 t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const upsert=SourceStore.prototype.upsert;
 t.mock.method(SourceStore.prototype,'upsert',async function(this:SourceStore,...args:Parameters<SourceStore['upsert']>){
  const result=await upsert.apply(this,args);written.push(args[1].externalId);
  if(!expired&&args[1].externalId==='generated-'+expireAfter){
   const step=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind='imports.commit' AND json_extract(input,'$.jobId')=? AND state='running'").get(importId);assert.ok(step);expired=true;
   // Simulate a scheduler pause beyond the existing lease, not an input change
   // or another owner confirmation. Exercise the real durable recovery pump.
   node.store.db.prepare('UPDATE execution_steps SET lease_until=0 WHERE id=?').run(step.id);await node.executor.tick();assert.equal(node.executor.get(String(step.id))!.state,'waiting');
  }
  return result;
 });
 const headers={authorization:'Bearer '+config.token};
 const created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{files:[{name:'generated.custom',dataBase64:Buffer.from('Generated archived bytes').toString('base64')}]}});assert.equal(created.statusCode,202,created.body);importId=created.json().id;await preparing;
 const early=await node.app.inject({method:'POST',url:`/api/imports/${importId}/confirm`,headers});assert.equal(early.statusCode,409,'an unreviewed import still requires a preview');
 const parseTask=node.importServices.importTasks.get(importId);release();await parseTask;assert.equal(node.imports.get(importId).status,'awaiting_confirmation');assert.equal(node.store.list().items.length,0);
 const identity=node.imports.confirmationIdentity(importId),confirmed=await node.app.inject({method:'POST',url:`/api/imports/${importId}/confirm`,headers});assert.equal(confirmed.statusCode,202,confirmed.body);await node.importServices.importTasks.get(importId);await node.executor.drain([identity]);
 const completed=node.imports.get(importId),step=node.executor.get(identity)!;assert.equal(expired,true);
 assert.equal(completed.status,'completed',JSON.stringify({status:completed.status,error:completed.error,progress:completed.progress,step,failure:node.executor.failure(identity)}));
 assert.equal(step.state,'succeeded');assert.equal(step.attempts,1,'lease interruption is not an extra processing failure');assert.equal(node.imports.confirmationIdentity(importId),identity);assert.deepEqual(completed.progress,{total:3,processed:3,imported:3,duplicates:0});assert.deepEqual(written,['generated-1','generated-2','generated-3']);assert.equal(parses,1);
 const originals=node.sources.listItems({sourceId:completed.sourceId}).items;assert.equal(originals.length,3);for(const item of originals)assert.equal(node.sources.history(completed.sourceId,item.externalId).length,1);
 const saved=JSON.stringify({completed,step});const again=await node.app.inject({method:'POST',url:`/api/imports/${importId}/confirm`,headers});assert.equal(again.statusCode,202);await node.executor.tick();assert.equal(JSON.stringify({completed:node.imports.get(importId),step:node.executor.get(identity)}),saved,'a completed import is only observed, not replayed');assert.deepEqual(written,['generated-1','generated-2','generated-3']);assert.equal(parses,1);
});
