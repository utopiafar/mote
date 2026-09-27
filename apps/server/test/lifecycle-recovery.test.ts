import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {ProviderAdmission} from '../src/provider-admission.js';
import {modelConfiguration} from '../src/model-configuration.js';

const text='Generated semantic failure input.';
async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-lifecycle-recovery-'));
  const config:Config={dataDir:directory,token:'generated-lifecycle-recovery-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTimeoutMs:5000};
  let calls=0;
  // No provider is constructed or contacted; all source text is generated.
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{calls++;throw new ProviderFailure({category:'permanent',code:'generated_semantic_failure'});}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const settings=node.lifecycle.settings();for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;settings.extraction.minChanges=1;node.lifecycle.configure(settings);
  const recordId=randomUUID();await node.store.ingest({id:recordId,deviceId:'fixture',deviceName:'Generated',platform:'import',capturedAt:'2026-09-27T00:00:00Z',source:'note',ocrText:text,durationMs:0});
  const save=(kind:'segment'|'semantic')=>{const id=kind==='segment'?'a'.repeat(64):'b'.repeat(64);node.store.archive.save(id,id,id,{kind,text,metadata:{complete:true,...(kind==='semantic'?{evidenceRanges:[{id:recordId,offset:0,length:text.length}]}:{})}},[{id:recordId,fingerprint:node.store.archive.fingerprint(recordId)!}],'fixture','1','fixture');return id;};
  const extraction=()=>node.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!;
  const owner={authorization:'Bearer '+config.token};
  return {node,recordId,save,extraction,owner,calls:()=>calls};
}

test('a terminal semantic child counts once and owner retry executes only its linked child again',async t=>{
  const f=await fixture(t);f.save('segment');await f.node.lifecycle.tick();
  const stopped=f.extraction();assert.equal(f.calls(),1);assert.equal(stopped.status,'failed');assert.equal(stopped.failures,1);assert.equal(stopped.manualRetryRequired,true);
  for(let i=0;i<3;i++)await f.node.lifecycle.tick();assert.equal(f.calls(),1);assert.equal(f.extraction().failures,1,'polling a terminal child is not another model attempt');
  const unrelated='c'.repeat(64);f.node.store.archive.save(unrelated,unrelated,unrelated,{kind:'segment',text,metadata:{complete:true}},[{id:f.recordId,fingerprint:f.node.store.archive.fingerprint(f.recordId)!}],'fixture','1','fixture');
  const selected=f.node.modelSettings.select('memory'),fingerprint=modelConfiguration(selected.id,selected.settings,f.node.modelSettings.view().revision).fingerprint;
  const foreign=f.node.workflows.enqueue([{name:'semantic',processor:'mote.segment-understanding',inputs:[],artifactInputs:[{id:unrelated,revision:f.node.store.archive.revision(unrelated)!}],config:{artifactId:unrelated,modelFingerprint:fingerprint}}]).semantic;
  await f.node.workflows.tick();assert.equal(f.node.workflows.view().jobs.find(job=>job.id===foreign)?.state,'failed');const before=f.calls();assert.equal(before,2);
  const status=await f.node.app.inject({method:'GET',url:'/api/memory-settings',headers:f.owner});assert.equal(status.json().extensions.find((item:{id:string})=>item.id==='extraction').status,'failed');
  const url='/api/memory-settings/extraction/'+stopped.active!.id+'/retry';
  assert.equal((await f.node.app.inject({method:'POST',url})).statusCode,401);
  assert.equal((await f.node.app.inject({method:'POST',url:'/api/memory-settings/extraction/'+randomUUID()+'/retry',headers:f.owner})).statusCode,409);
  const response=await f.node.app.inject({method:'POST',url,headers:f.owner});assert.equal(response.statusCode,202);await f.node.lifecycle.tick();
  assert.equal(f.calls(),before+1,'explicit owner recovery re-executes only the linked semantic child');assert.equal(f.node.workflows.view().jobs.find(job=>job.id===foreign)?.state,'failed');
  const state=JSON.parse(String(f.node.store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='extraction'").get()!.json));state.retryAt=0;f.node.store.db.prepare("UPDATE memory_lifecycle_state SET json=? WHERE id='extraction'").run(JSON.stringify(state));
  f.node.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run('lifecycle:'+stopped.active!.id);
  await f.node.lifecycle.tick();assert.equal(f.calls(),before+1);assert.equal(f.extraction().failures,1);assert.equal(f.extraction().status,'failed');
});

test('a retryable failed batch does not appear terminal before its next lifecycle turn',async t=>{
  const f=await fixture(t);f.save('semantic');await f.node.lifecycle.tick();assert.equal(f.calls(),1);
  const state=JSON.parse(String(f.node.store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='extraction'").get()!.json));state.retryAt=0;f.node.store.db.prepare("UPDATE memory_lifecycle_state SET json=? WHERE id='extraction'").run(JSON.stringify(state));
  const pending=f.extraction();assert.equal(pending.status,'pending');assert.equal(pending.failures,1);
  const response=await f.node.app.inject({method:'GET',url:'/api/memory-settings',headers:f.owner});assert.equal(response.json().extensions.find((item:{id:string})=>item.id==='extraction').status,'pending');
  const retry=await f.node.app.inject({method:'POST',url:'/api/memory-settings/extraction/'+pending.active!.id+'/retry',headers:f.owner});assert.equal(retry.statusCode,409);assert.equal(f.calls(),1);
});

test('a shared provider cooldown before the first batch waits without charging a failed turn',async t=>{
  const f=await fixture(t);f.save('semantic');
  const admission=new ProviderAdmission(f.node.store);
  await admission.run(f.node.modelSettings.select('memory').settings,async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:600000});}).catch(()=>{});
  await f.node.lifecycle.tick();const waiting=f.extraction();assert.equal(f.calls(),0);assert.equal(waiting.failures,0);assert.equal(waiting.status,'retry_wait');assert.equal(waiting.error,'rate_limited');
});
