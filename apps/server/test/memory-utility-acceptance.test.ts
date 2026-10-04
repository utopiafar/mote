import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {seedUtilityOracle} from './fixtures/utility-oracle.js';

test('owner integration creates a reviewed actionable replacement, applies its relation atomically, and invalidates it after original deletion',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-utility-acceptance-')),token='generated-owner-utility-token',headers={authorization:'Bearer '+token};
 const config:Config={dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture-model',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let seed:Awaited<ReturnType<typeof seedUtilityOracle>>;
 const calls:QueryInput[]=[];
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  calls.push(input);assert.equal(input.skill,'memory-integration');assert.equal(node.memories.get(seed.cards[0].id).supersededBy,undefined,'generation and review cannot publish a relationship');assert.equal(node.memories.list().length,2,'no intermediate new card before atomic commit');
  const originals=node.memories.readEvidence(seed.ids),old=node.memories.get(seed.cards[0].id);
  const claim={domain:'personal',title:'Generated current publishing rule',statement:`For ${seed.oracle.project}, use gate ${seed.oracle.releaseGate} and artifact tag ${seed.oracle.artifactTag}; prior gate ${seed.oracle.priorGate} is retired ${seed.ids.map(id=>'['+id+']').join(' ')}`,uncertainty:'Scoped generated owner decision.',admission:{layer:'memory',reason:'Retrieve the current rule instead of the retired event card',scope:seed.oracle.project,attribution:'user'},relatedMemoryIds:seed.cards.map(card=>card.id),evidenceIds:seed.ids,evidence:originals.map(original=>({id:original.id,quote:original.ocrText})),relations:[{kind:'supersedes',memoryId:old.id,fingerprint:old.fingerprint,version:old.version}]};
  return {answer:JSON.stringify({memories:[claim]}),citations:originals.map(original=>({id:original.id,capturedAt:original.capturedAt,appName:original.appName,excerpt:original.ocrText})),trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:seed.ids}};
 }}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});await node.app.ready();
 const settings=node.lifecycle.settings();for(const id of ['extraction','consolidation','insights','working'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);
 seed=await seedUtilityOracle(node,token);const prior=seed.cards[0];
 const requested=await node.app.inject({method:'POST',url:'/api/memory-integrations',headers,payload:{recipe:{id:'mote.memory-integration',version:'2'},memoryIds:seed.cards.map(card=>card.id)}});assert.equal(requested.statusCode,202,requested.body);await node.lifecycle.tick();
 const state=node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!;assert.equal(state.error,undefined);assert.equal(state.active,undefined);assert.deepEqual(calls.map(call=>call.traceContext?.phase),['extract','review']);
 const products=node.memories.list().filter(card=>card.tier==='consolidated');assert.equal(products.length,1,'this case must demonstrate nonzero utility');
 const product=node.memories.get(products[0].id);assert.equal(product.status,'published');assert.equal(product.reviewReceipt?.decision,'independent');assert.equal(product.reviewReceipt?.reviewRunId,product.reviewRunId);assert.notEqual(product.reviewReceipt?.draftRunId,product.reviewReceipt?.reviewRunId,'review is a separate model result');assert.deepEqual(new Set(product.evidenceIds),new Set(seed.ids));
 assert.match(product.statement,new RegExp(seed.oracle.releaseGate));assert.match(product.statement,new RegExp(seed.oracle.artifactTag));assert.equal(node.memories.get(prior.id).supersededBy,product.id);assert.equal(node.memories.get(prior.id).version,prior.version!+1);assert.equal(product.relations?.[0].fingerprint,prior.fingerprint);
 await node.lifecycle.tick();assert.equal(calls.length,2,'a completed integration does not replay');
 const removed=await node.app.inject({method:'DELETE',url:'/api/captures/'+seed.ids[1],headers});assert.equal(removed.statusCode,200,removed.body);assert.throws(()=>node.memories.get(product.id),{statusCode:404});assert.throws(()=>node.memories.publish(product.id),{statusCode:404});assert.ok(!node.memories.list().some(card=>card.id===product.id));assert.equal(calls.length,2,'deletion removes dependent cards and cannot create or republish a replacement');
});
