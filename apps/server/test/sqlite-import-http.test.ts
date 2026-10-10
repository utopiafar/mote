import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('HTTP import survives FTS cleanup, records parser failure, retries, confirms and restarts',{timeout:30_000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-sqlite-import-http-'));
 const config:Config={dataDir:directory,token:'generated-sqlite-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let calls=0;
 const dependencies={backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('Fixture must not call a model');}},prepareImport:async(input:import('../src/imports.js').ImportPreparation)=>{
  if(++calls===1){
   const db=node.store.db,insert=db.prepare('INSERT INTO material_fts(rowid,material_id,text) VALUES(?,?,?)');
   for(let i=1;i<=3000;i++)insert.run(i,'generated-index-'+i,'Generated searchable fixture '+i);
   db.prepare('DELETE FROM material_fts WHERE rowid=1').run();db.prepare('DELETE FROM material_fts WHERE rowid=2').run();
   throw Error('Generated parser failure after FTS cleanup');
  }
  writeFileSync(join(input.workspace,'records.jsonl'),JSON.stringify({item:{externalId:'generated-original',revision:'1',observedAt:'2026-10-10T00:00:00Z',kind:'file',layer:'original',title:'Generated original',text:'Generated original retained after retry'},evidencePaths:input.inputPaths})+'\n');
  return {summary:'Generated retry preview'};
 }};
 let node=await buildApp(config,dependencies);await node.app.ready();
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token};
 const wait=async(id:string,status:string)=>{
  for(const deadline=Date.now()+10_000;Date.now()<deadline;){
   const response=await node.app.inject({url:`/api/imports/${id}`,headers});assert.equal(response.statusCode,200,response.body);
   if(response.json().status===status)return response.json();await delay(250);
  }
  assert.fail('Import did not reach '+status);
 };
 const created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{files:[{name:'generated.custom',dataBase64:Buffer.from('Generated original retained after retry').toString('base64')}]}});
 assert.equal(created.statusCode,202,created.body);const id=created.json().id;
 const failed=await wait(id,'failed');assert.equal(calls,1);
 assert.match(failed.error,/Generated parser failure/);
 assert.equal(node.archivedFiles.read(failed.files[0].id).toString(),'Generated original retained after retry');
 const retried=await node.app.inject({method:'POST',url:`/api/imports/${id}/retry`,headers});assert.equal(retried.statusCode,202,retried.body);
 await wait(id,'awaiting_confirmation');
 const confirmed=await node.app.inject({method:'POST',url:`/api/imports/${id}/confirm`,headers});assert.equal(confirmed.statusCode,202,confirmed.body);
 const completed=await wait(id,'completed');assert.equal(completed.progress.imported,1);assert.equal(calls,2);
 assert.equal(node.store.evidence(completed.captureIds)[0]!.ocrText,'Generated original retained after retry');
 await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();
 assert.equal((await wait(id,'completed')).progress.imported,1);assert.equal(calls,2,'restart must retain success without rerunning the parser');
 assert.equal(node.archivedFiles.read(failed.files[0].id).toString(),'Generated original retained after retry');
});
