import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

// Real Central owner controls and its default lifecycle extraction extension.
// Only the semantic provider and its already-completed generated artifact are
// fixtures; this does not claim actual model interpretation or native service QA.
test('owner immediate stop cancels the default automatic lifecycle failed child across restart while preserving independent manual work',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-lifecycle-child-stop-')),owner='generated-owner-'+randomUUID();
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpWriteEnabled:false}};
  let calls=0;
  const agent={configured:true,async query(){calls++;throw new ProviderFailure({category:'permanent',code:'generated_provider_failure'});},async close(){}};
  let node=await buildApp(config,{backgroundWorker:false,agent});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+owner},sourceId=randomUUID(),text='Generated source with no personal data.';
  const received=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:sourceId,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:new Date().toISOString(),text}});
  assert.equal(received.statusCode,201,received.body);
  const artifactId='a'.repeat(64);
  node.store.archive.save(artifactId,artifactId,artifactId,{kind:'semantic',text:'Generated previously completed interpretation',metadata:{complete:true,evidenceRanges:[{id:sourceId,offset:0,length:text.length}]}},[{id:sourceId,fingerprint:node.store.archive.fingerprint(sourceId)!}],'generated','1','generated');
  const settings=node.lifecycle.settings();settings.extraction.minChanges=1;
  for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;
  node.lifecycle.configure(settings);await node.lifecycle.tick();
  const extraction=node.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!,window=extraction.active!;
  assert.equal(window.manual,false);assert.ok(window.checkpoint);
  const child=node.memoryPipeline.get(window.checkpoint!);
  assert.equal(child.status,'failed');assert.equal(child.importJobId,'lifecycle:'+window.id);
  assert.equal(child.automaticGrant,undefined);assert.equal(child.automaticGrants,undefined);
  assert.equal(calls,1);
  const manual=node.memoryPipeline.create({evidenceIds:[sourceId],importJobId:'lifecycle:generated-independent-import'});
  const continuation=node.memoryPipeline.create({evidenceIds:[sourceId]});
  // Generated host metadata models a separately authorized owner reply. The
  // owner-question journey tests verify how the real reply creates this link.
  node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.continuationOf',?) WHERE id=?").run(child.id,continuation.id);
  const manualWindowId=node.lifecycle.request('consolidation',[randomUUID()],'generated-explicit-manual-checkpoint');
  const before=(await node.app.inject({method:'GET',url:'/api/memory-spaces/default/binding',headers})).json();
  const stopped=await node.app.inject({method:'POST',url:'/api/memory-spaces/default/binding/stop',headers,payload:{operationId:randomUUID(),expectedRevision:before.revision}});
  assert.equal(stopped.statusCode,200,stopped.body);
  assert.equal(node.memoryPipeline.get(child.id).status,'cancelled');
  assert.equal(node.memoryPipeline.get(child.id).cancellationCause,'authority');
  assert.equal(node.memoryPipeline.get(manual.id).status,'queued');
  assert.equal(node.memoryPipeline.get(continuation.id).status,'queued','automatic stop does not revoke a later explicit owner continuation');
  assert.equal(node.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!.active!.checkpoint,child.id);
  assert.equal(node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!.active!.id,manualWindowId);
  assert.notEqual(node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!.status,'cancelled');
  // Upgrade regression: the earlier host persisted the cancelled parent but
  // had already removed its child abort listener after failure. Recreate only
  // that generated old child row; startup must reconcile the saved checkpoint.
  const legacyChild=JSON.parse(String(node.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(child.id)!.json));
  legacyChild.status='failed';delete legacyChild.cancellationCause;
  node.store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify(legacyChild),child.id);
  await node.app.close();node=await buildApp(config,{backgroundWorker:false,agent});
  assert.equal(node.memoryPipeline.get(child.id).status,'cancelled');
  assert.equal(node.memoryPipeline.get(child.id).cancellationCause,'authority');
  assert.equal(node.memoryPipeline.get(manual.id).status,'queued');
  assert.equal(node.memoryPipeline.get(continuation.id).status,'queued');
  assert.equal(node.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!.active!.checkpoint,child.id,'restart replays cancellation without losing the durable child identity');
  assert.equal(calls,1,'restart cancellation needs no model call');
});
