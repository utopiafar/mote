import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ImportPreparation} from '../src/imports.js';

for(const scenario of ['initial','retry-after-restart','unbound-retry'] as const)test(`owner import retains model authority on ${scenario} without background approval`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-import-owner-authority-'));
 const config:Config={dataDir:directory,token:'generated-import-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let node:Awaited<ReturnType<typeof buildApp>>,calls=0;
 const dependencies={backgroundWorker:false,prepareImport:async(input:ImportPreparation)=>{
  calls++;
  const connection=node.featureServices.availableModelConnections().find(value=>value.id==='profile:env:deployment:generated-model');
  assert.ok(connection);
  node.modelAuthorization.assertCurrent(connection);
  assert.equal(node.modelAuthorization.currentKind,'manual');
  assert.ok(node.modelAuthorization.ownerIntent(input.operationId!));
  if(scenario==='retry-after-restart'&&calls===1)throw Error('Generated parser failure');
  writeFileSync(join(input.workspace,'records.jsonl'),JSON.stringify({item:{externalId:'generated-record',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'file',layer:'original',text:'Generated original'},evidencePaths:[input.inputPaths[0]],attachments:[]})+'\n');
  return {summary:'Generated preview'};
 }};
 node=await buildApp(config,dependencies);
 await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token};
 const payload={instruction:'Generated owner context',files:[{name:'generated.custom',dataBase64:Buffer.from('Generated original').toString('base64')}]};
 const denied=await node.app.inject({method:'POST',url:'/api/imports',payload});assert.equal(denied.statusCode,401);
 let id:string;
 if(scenario==='unbound-retry'){
  id=(await node.imports.create(payload)).id;
  node.modelAuthorization.manual('unrelated-owner','manual',['import:other']);
  await node.modelAuthorization.run('unrelated-owner',()=>node.imports.prepare(id));
  assert.equal(node.imports.get(id).status,'failed','a different owner operation cannot lend its authority to this import');
 }else{
  const created=await node.app.inject({method:'POST',url:'/api/imports',headers,payload});
  assert.equal(created.statusCode,202,created.body);id=created.json().id;
  await node.importServices.importTasks.get(id);
 }
 let job=node.imports.get(id);
 if(scenario!=='initial'){
  assert.equal(job.status,'failed');assert.match(job.error??'',scenario==='unbound-retry'?/owner authorization/:/Generated parser failure/);
  await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();
  const retried=await node.app.inject({method:'POST',url:`/api/imports/${id}/retry`,headers});assert.equal(retried.statusCode,202,retried.body);
  await node.importServices.importTasks.get(id);job=node.imports.get(id);
 }
 assert.equal(job.status,'awaiting_confirmation',job.error);
 assert.equal(job.preview?.count,1);assert.equal(calls,scenario==='initial'?1:2);
 const confirmed=await node.app.inject({method:'POST',url:`/api/imports/${id}/confirm`,headers});assert.equal(confirmed.statusCode,202,confirmed.body);
 await node.importServices.importTasks.get(id);job=node.imports.get(id);
 assert.equal(job.status,'completed');assert.equal(job.progress.imported,1);
 assert.equal(node.modelAuthorization.view().state,'unapproved','a manual import must not authorize unrelated background work');
});

test('an explicitly retried import reports queued while another import is using the worker',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-import-retry-queue-'));
 const config:Config={dataDir:directory,token:'generated-import-queue-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let entered!:()=>void,release!:()=>void,failed=false;const blockerStarted=new Promise<void>(resolve=>entered=resolve),blocker=new Promise<void>(resolve=>release=resolve);
 const node=await buildApp(config,{backgroundWorker:false,prepareImport:async(input:ImportPreparation)=>{
  const source=readFileSync(input.inputPaths[0],'utf8');
  if(source==='generated-target'&&!failed){failed=true;throw Error('Generated parser failure');}
  if(source==='generated-blocker'){entered();await blocker;}
  writeFileSync(join(input.workspace,'records.jsonl'),JSON.stringify({item:{externalId:source,revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'file',layer:'original',text:source},evidencePaths:[input.inputPaths[0]],attachments:[]})+'\n');
  return {summary:'Generated preview'};
 }});await node.app.ready();t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token};
 const create=async(text:string)=>{const response=await node.app.inject({method:'POST',url:'/api/imports',headers,payload:{files:[{name:'generated.custom',dataBase64:Buffer.from(text).toString('base64')}]}});assert.equal(response.statusCode,202);return response.json().id as string;};
 const target=await create('generated-target');await node.importServices.importTasks.get(target);assert.equal(node.imports.get(target).status,'failed');
 const occupying=await create('generated-blocker');await blockerStarted;
 const retry=await node.app.inject({method:'POST',url:`/api/imports/${target}/retry`,headers});assert.equal(retry.statusCode,202);
 const deadline=Date.now()+5000;while(Date.now()<deadline){const step=node.store.db.prepare("SELECT state FROM execution_steps WHERE kind='imports.prepare' AND json_extract(input,'$.jobId')=?").get(target);if(step?.state==='waiting')break;await setTimeout(10);}
 const step=node.store.db.prepare("SELECT state FROM execution_steps WHERE kind='imports.prepare' AND json_extract(input,'$.jobId')=?").get(target);
 assert.equal(step?.state,'waiting');const queued=node.imports.get(target);
 assert.equal(queued.status,'queued');assert.equal(queued.processingStatus,'archived');assert.equal(queued.error,undefined);
 release();await Promise.all([node.importServices.importTasks.get(occupying),node.importServices.importTasks.get(target)]);
 assert.equal(node.imports.get(target).status,'awaiting_confirmation');
});
