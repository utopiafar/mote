import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('owner cancellation aborts import parsing, fences late results, survives restart and resumes only explicitly',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-import-cancel-'));
 const config:Config={dataDir:directory,token:'generated-import-cancel-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let calls=0,release!:()=>void,entered!:()=>void,signal:AbortSignal|undefined;
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const dependencies={backgroundWorker:false,agent:{configured:false,close:async()=>{},query:async()=>{throw Error('No real model');}},prepareImport:async(input:import('../src/imports.js').ImportPreparation)=>{
  calls++;signal=input.signal;if(calls===1){entered();await gate;}
  writeFileSync(join(input.workspace,'records.jsonl'),JSON.stringify({item:{externalId:'generated-one',revision:'1',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original',title:'Generated',text:'Generated original'},evidencePaths:[input.inputPaths[0]],attachments:[]})+'\n');
  if(calls===1)writeFileSync(join(input.workspace,'dispositions.json'),JSON.stringify({items:[{path:input.inputPaths[0],status:'parsed',reason:'Generated complete input'}]}));
  return {summary:'Generated parser result',...(calls===1?{reviewDecision:{confidence:'high' as const,ambiguous:false,reason:'Generated exact mapping'}}:{})};
 }};
 let node=await buildApp(config,dependencies);await node.app.ready();
 t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token};
 const get=async(id:string)=>(await node.app.inject({method:'GET',url:'/api/imports/'+id,headers})).json();
 const wait=async(id:string,status:string)=>{for(let i=0;i<100;i++){const job=await get(id);if(job.status===status)return job;await setTimeout(10);}assert.fail('Import did not reach '+status);};
 const created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{processing:'automatic',files:[{name:'generated.custom',dataBase64:Buffer.from('Generated original').toString('base64')}]}});assert.equal(created.statusCode,202);
 const id=created.json().id;await started;
 const {invitation}=node.connections.invite({serverUrl:'http://127.0.0.1:3456',label:'Generated collector'});const collector=await node.connections.redeem({code:invitation.code,deviceId:'generated',deviceName:'Generated',platform:'macos'});
 for(const [authorization,status] of [['',401],['Bearer '+collector.token,403]] as const)assert.equal((await node.app.inject({method:'POST',url:`/api/imports/${id}/cancel`,headers:{authorization}})).statusCode,status);
 const cancelled=await node.app.inject({method:'POST',url:`/api/imports/${id}/cancel`,headers});assert.equal(cancelled.statusCode,200);assert.equal(cancelled.json().status,'cancelled');assert.equal(signal?.aborted,true);
 const premature=await node.app.inject({method:'POST',url:`/api/imports/${id}/retry`,headers});assert.equal(premature.statusCode,409);assert.equal(premature.json().error,'import_stopping');assert.equal(calls,1);
 await setTimeout(3100);assert.equal(node.featureServices.importTasks.has(id),false,'logical task is settled while physical parser is still held');
 const delayed=await node.app.inject({method:'POST',url:`/api/imports/${id}/retry`,headers});assert.equal(delayed.statusCode,409);assert.equal(delayed.json().error,'import_stopping');assert.equal((await get(id)).status,'cancelled');assert.equal(calls,1);
 await assert.rejects(node.imports.retry(id),{statusCode:409});assert.equal((await get(id)).status,'cancelled');
 release();await node.featureServices.executor.drain(node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'imports.%'").all().map(row=>String(row.id)));
 for(let i=0;i<100&&node.imports.hasActiveWorker(id);i++)await setTimeout(10);assert.equal(node.imports.hasActiveWorker(id),false);
 assert.equal((await get(id)).status,'cancelled');assert.equal((await get(id)).preview,undefined);assert.equal(node.store.list().items.length,0);
 const file=cancelled.json().files[0];assert.equal(node.archivedFiles.read(file.id).toString(),'Generated original');
 await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();await node.featureServices.executor.tick();await node.featureServices.executor.drain(node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'imports.%'").all().map(row=>String(row.id)));
 assert.equal((await get(id)).status,'cancelled');assert.equal(calls,1);
 const retried=await node.app.inject({method:'POST',url:`/api/imports/${id}/retry`,headers});assert.equal(retried.statusCode,202);await wait(id,'awaiting_confirmation');assert.equal(calls,2);
 const previewCancel=await node.app.inject({method:'POST',url:`/api/imports/${id}/cancel`,headers});assert.equal(previewCancel.statusCode,409);assert.equal((await get(id)).status,'awaiting_confirmation');
 const confirmed=await node.app.inject({method:'POST',url:`/api/imports/${id}/confirm`,headers});assert.equal(confirmed.statusCode,202);await wait(id,'completed');
 const late=await node.app.inject({method:'POST',url:`/api/imports/${id}/cancel`,headers});assert.equal(late.json().status,'completed');assert.equal(node.store.list().items.length,1);assert.equal(node.archivedFiles.read(file.id).toString(),'Generated original');
});
