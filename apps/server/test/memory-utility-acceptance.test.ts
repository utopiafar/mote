import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {seedUtilityOracle} from './fixtures/utility-oracle.js';

test('owner integration creates a reviewed actionable replacement, applies its relation atomically, and invalidates it after original deletion',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-utility-acceptance-')),token='generated-owner-utility-token',headers={authorization:'Bearer '+token};
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-fixture-model',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
 let seed:Awaited<ReturnType<typeof seedUtilityOracle>>;
 const calls:QueryInput[]=[];
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  calls.push(input);assert.equal(input.skill,'memory-integration');assert.equal(node.memories.get(seed.cards[0].id).supersededBy,undefined,'generation and review cannot publish a relationship');assert.equal(node.memories.list().length,2,'no intermediate new card before atomic commit');
  const originals=node.memories.readEvidence(seed.ids),old=node.memories.get(seed.cards[0].id);input.onEvidence?.(originals);
  const claim={domain:'personal',title:'Generated current publishing rule',statement:`For ${seed.oracle.project}, use gate ${seed.oracle.releaseGate} and artifact tag ${seed.oracle.artifactTag}; prior gate ${seed.oracle.priorGate} is retired ${seed.ids.map(id=>'['+id+']').join(' ')}`,uncertainty:'Scoped generated owner decision.',admission:{layer:'memory',reason:'Retrieve the current rule instead of the retired event card',scope:seed.oracle.project,attribution:'user'},relatedMemoryIds:seed.cards.map(card=>card.id),evidenceIds:seed.ids,evidence:originals.map(original=>({id:original.id,quote:original.ocrText})),relations:[{kind:'supersedes',memoryId:old.id,fingerprint:old.fingerprint,version:old.version}]};
  return {answer:JSON.stringify({memories:[claim]}),citations:originals.map(original=>({id:original.id,capturedAt:original.capturedAt,appName:original.appName,excerpt:original.ocrText})),trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:seed.ids}};
 }}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});await node.app.ready();
 const settings=node.lifecycle.settings();for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;await node.lifecycle.save({revision:node.configService.revision,settings});
 seed=await seedUtilityOracle(node,token);const prior=seed.cards[0];
 const requested=await node.app.inject({method:'POST',url:'/api/memory-integrations',headers,payload:{recipe:{id:'mote.memory-integration',version:'2'},inputs:seed.cards.map(card=>{const current=node.memories.get(card.id);return {id:current.id,version:current.version,fingerprint:current.fingerprint};})}});assert.equal(requested.statusCode,202,requested.body);await node.lifecycle.tick();
 const state=node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!;assert.equal(state.error,undefined);assert.equal(state.active,undefined);assert.deepEqual(calls.map(call=>call.traceContext?.phase),['extract','review']);
 const products=node.memories.list().filter(card=>card.tier==='consolidated');assert.equal(products.length,1,'this case must demonstrate nonzero utility');
 const product=node.memories.get(products[0].id);assert.equal(product.status,'published');assert.equal(product.reviewReceipt?.decision,'independent');assert.equal(product.reviewReceipt?.reviewRunId,product.reviewRunId);assert.notEqual(product.reviewReceipt?.draftRunId,product.reviewReceipt?.reviewRunId,'review is a separate model result');assert.deepEqual(new Set(product.evidenceIds),new Set(seed.ids));
 assert.match(product.statement,new RegExp(seed.oracle.releaseGate));assert.match(product.statement,new RegExp(seed.oracle.artifactTag));assert.equal(node.memories.get(prior.id).supersededBy,product.id);assert.equal(node.memories.get(prior.id).version,prior.version!+1);assert.equal(product.relations?.[0].fingerprint,prior.fingerprint);
 await node.lifecycle.tick();assert.equal(calls.length,2,'a completed integration does not replay');
 const removed=await node.app.inject({method:'DELETE',url:'/api/captures/'+seed.ids[1],headers});assert.equal(removed.statusCode,200,removed.body);const unavailable=await node.app.inject({url:'/api/memories/'+product.id,headers});assert.equal(unavailable.statusCode,410,unavailable.body);assert.ok(!unavailable.body.includes(product.statement));const rejected=await node.app.inject({method:'POST',url:'/api/memories/'+product.id+'/publish',headers,payload:{version:product.version}});assert.equal(rejected.statusCode,409,rejected.body);assert.ok(!rejected.body.includes(product.statement));
 const visible=await node.app.inject({url:'/api/memories',headers});assert.equal(visible.statusCode,200,visible.body);assert.ok(!visible.body.includes(product.statement));
 assert.equal(node.memories.get(product.id).fingerprint,product.fingerprint,'release retains only the existing publication identity for trusted history');assert.equal(calls.length,2,'release hides dependent cards and cannot create or republish a replacement');
});
