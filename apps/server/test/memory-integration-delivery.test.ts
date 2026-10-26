import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {QueryInput,ContextReader} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import type {Config} from '../src/config.js';
import type {RecordingProvider} from '../src/connectors/recordings.js';
import {feishuTranscript} from '../src/connectors/recording-formats.js';
import {dingtalkTranscript} from '../src/connectors/dingtalk-recordings.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {generatedNativeAdapter} from './fixtures/native-engine-adapter.js';

type Mode='read'|'skip'|'empty-wire'|'revoke'|'bad-proof';
async function fixture(t:TestContext,providerId:'feishu'|'dingtalk',mode:Mode){
 const dataDir=await mkdtemp(join(tmpdir(),'mote-recording-integration-')),token='generated-integration-owner',headers={authorization:'Bearer '+token};
 const original='Owner 00:00:00.000\nI prefer quiet mornings for focused work.\n';
 const provider:RecordingProvider={id:providerId,version:'generated@1',account:async()=>({id:'generated-owner',name:'Generated owner'}),discover:async()=>({ids:['generated-recording']}),
  metadata:async()=>({id:'generated-recording',title:'Generated recording',recordedAt:'2026-09-20T00:00:00Z',durationMs:5000}),transcript:async()=>providerId==='feishu'?{rawText:original,transcript:feishuTranscript(original,5000)}:dingtalkTranscript({taskUuid:'generated-recording',complete:true,paragraphList:[{nickName:'Owner',paragraph:'I prefer quiet mornings for focused work.',sentenceList:[{sentence:'I prefer quiet mornings for focused work.'}]}]},5000),media:async()=>({mimeType:'audio/wav',bytes:Buffer.concat([Buffer.from('RIFF0000WAVE'),Buffer.alloc(200)])})};
 const cfg:Config={dataDir,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let node!:Awaited<ReturnType<typeof buildApp>>,rawId='';const calls:{skill?:string;phase?:string}[]=[],wire:{items:number;evidence:number;sourceEvidence:number}[]=[],seedDeliveries:number[]=[];let transportDenied=false;
 const dependencies:NonNullable<Parameters<typeof buildApp>[1]>={backgroundWorker:false,connectorTesting:{recordings:[provider]},createModelAgent:async(_settings,reader,host)=>({configured:true,close:async()=>{},query:async(input:QueryInput)=>{
  if(await planGeneratedMemory(input))return {answer:'Generated packages submitted.',citations:[],trace:[],runId:randomUUID()};
  calls.push({skill:input.skill,phase:input.traceContext?.phase});
  if(input.skill==='memory-integration'){
   const ids=JSON.parse(input.question.slice(input.question.lastIndexOf('\n')+1)) as string[];
   assert.deepEqual(await reader.evidence({ids:[rawId]}),[],'reading the derived card must not mint raw recording JSON access');
   if(mode==='skip')return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};
   const actual:ContextReader=mode==='empty-wire'?{...reader,memories:async()=>({items:[],nextCursor:null})}:reader;
   const bridge=await startBridge(actual,input,24);
   try{
    for(const id of ids){const response=await fetch(bridge.url+'/memories',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({id,includeEvidence:true})});const body:any=await response.json();assert.equal(response.status,200,JSON.stringify(body));wire.push({items:body.data.items.length,evidence:body.data.evidence.length,sourceEvidence:body.data.sourceEvidence.length});}
    if(mode==='revoke'){node.store.delete(rawId);await assert.rejects(async()=>host!.authorizeModelRequest!());transportDenied=true;}
    return {answer:'{"memories":[]}',citations:[],trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies};
   }finally{await bridge.close();}
  }
  const records=await reader.evidence({ids:input.evidenceIds!});seedDeliveries.push(records.length);assert.equal(records.length,input.evidenceIds!.length);
  const record=records.find(value=>value.ocrText.includes('quiet mornings'))!;assert.ok(record);
  const candidate={domain:'personal',title:'Generated focused work preference',statement:`The generated owner prefers quiet mornings for focused work [${record.id}]`,uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Explicit generated preference',scope:'Generated fixture',attribution:'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote:'I prefer quiet mornings for focused work.'}]};
  return {answer:generatedMemoryOutput(input,[candidate]),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''}],trace:[],runId:randomUUID()};
 }})};
 node=await buildApp(cfg,dependencies);
 t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});
 const settings=node.lifecycle.settings();for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;await node.lifecycle.save({revision:node.configService.revision,settings});await node.app.ready();
 const api=async(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>{const response=await node.app.inject({method,url,headers,...(payload?{payload}:{})});assert.equal(response.statusCode,200,response.body);return response.json();};
 const authorization=(await node.app.inject({url:'/api/model-authorization',headers:{authorization:'Bearer '+token}})).json();
 const consent=await node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:{authorization:'Bearer '+token},payload:{revision:authorization.authorization.revision,operationId:randomUUID(),action:'authorize',connections:authorization.connections,scope:{sourceIds:null,dataKinds:['text','image','audio','conversation']}}});assert.equal(consent.statusCode,200,consent.body);
 await api('PUT','/api/memory-integration-settings',{recipe:{id:'mote.memory-integration',version:'2'}});
 await api('POST',`/api/connectors/${providerId}-recordings/connect`);await api('PUT',`/api/connectors/${providerId}-recordings/selection`,{enabled:true,start:'2026-09-01T00:00:00Z',end:'2026-10-01T00:00:00Z',autoSync:false,backupAudio:true});
 for(let n=0;n<30;n++){const rows=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE ? AND state IN ('waiting','running') AND available_at<=? LIMIT 100").all('recording.'+providerId+'.%',Date.now());if(!rows.length)break;await node.executor.drain(rows.map(row=>String(row.id)));}
 await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);await Promise.all(node.memoryPipeline.list().filter(job=>['queued','running'].includes(job.status)).map(job=>node.memoryPipeline.run(job.id)));
 const source=await api('GET',`/api/connectors/${providerId}-recordings`);rawId=node.sources.getItem(source.sourceId,'generated-recording')!.captureId;
 const cards=node.memories.list().map(card=>node.memories.get(card.id)).filter(card=>card.status==='published'&&card.admission?.layer==='memory');assert.equal(cards.length,1);assert.deepEqual(seedDeliveries,[1,1]);
 const originalDependencies=node.store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=?').all(cards[0].id).map(row=>String(row.evidence_id));assert.ok(originalDependencies.includes(rawId));
 if(mode==='bad-proof')node.store.db.prepare("UPDATE memories SET json=json_set(json,'$.evidence[0].contentHash',?) WHERE id=?").run('0'.repeat(64),cards[0].id);
 const next=node.lifecycle.settings();next.consolidation.enabled=true;next.consolidation.minChanges=1;await node.lifecycle.save({revision:node.configService.revision,settings:next});
 const view=()=>node.lifecycle.view().extensions.find(item=>item.id==='consolidation')!;const before=view();await node.lifecycle.tick();
 return {get node(){return node;},cards,rawId,sourceId:source.sourceId,calls,wire,before,view,get transportDenied(){return transportDenied;},async restart(){await node.app.close();node=await buildApp(cfg,dependencies);await node.app.ready();},receipts:()=>node.store.db.prepare('SELECT json FROM memory_integration_deliveries').all().map(row=>JSON.parse(String(row.json)))};
}

for(const source of ['feishu','dingtalk'] as const)test(`${source} recording reaches actual Memory tools through its exact Material proof without granting raw reads`,async t=>{
 const f=await fixture(t,source,'read');assert.deepEqual(f.wire,[{items:1,evidence:1,sourceEvidence:1}]);assert.equal(f.view().error,undefined);assert.equal(f.view().active,undefined);assert.ok(f.view().cursor>f.before.cursor);assert.equal(f.view().pendingChanges,0);
 assert.equal(f.calls.filter(call=>call.skill==='memory-integration').length,1,'a genuine read followed by no useful relation stays a valid zero result');assert.equal(f.receipts()[0].memoryIds.length,1);assert.equal(f.receipts()[0].evidenceIds.length,1);
 await f.restart();await f.node.lifecycle.tick();assert.equal(f.calls.filter(call=>call.skill==='memory-integration').length,1,'success does not replay the old paid window after restart');assert.equal(f.receipts()[0].memoryIds.length,1);
});
for(const mode of ['skip','empty-wire'] as const)test(`${mode} cannot turn absent actual body delivery into a successful integration window`,async t=>{
 const f=await fixture(t,'feishu',mode);assert.equal(f.view().cursor,f.before.cursor);assert.ok(f.view().active);assert.equal(f.view().error,'memory_integration_no_delivery');assert.equal(f.view().manualRetryRequired,true);assert.equal(f.receipts()[0].memoryIds.length,0);assert.equal(f.receipts()[0].evidenceIds.length,0);
 await f.restart();await f.node.lifecycle.tick();assert.equal(f.view().manualRetryRequired,true);assert.equal(f.calls.filter(call=>call.skill==='memory-integration').length,1,'a host delivery gap never schedules another paid attempt automatically after restart');assert.equal(f.receipts()[0].memoryIds.length,0);
});
test('exact proof preflight rejects an unreadable selected card before starting an integration model',async t=>{
 const f=await fixture(t,'feishu','bad-proof');assert.equal(f.calls.filter(call=>call.skill==='memory-integration').length,0);assert.equal(f.view().cursor,f.before.cursor);assert.equal(f.view().error,'memory_integration_unreadable');assert.equal(f.view().manualRetryRequired,true);assert.equal(f.receipts().length,0);
});
test('revocation after actual card disclosure blocks the next send and final consumption',async t=>{
 const f=await fixture(t,'feishu','revoke');assert.equal(f.transportDenied,true);assert.equal(f.view().cursor,f.before.cursor);assert.ok(f.view().active);assert.ok(f.view().error);assert.equal(f.node.memories.list({tier:'consolidated'}).length,0);
});

test('a readable same-source Material cannot authorize an unrelated raw ancestor',async t=>{
 const f=await fixture(t,'feishu','read'),reader=f.node.featureServices.evidenceReader;
 const other=await f.node.sources.upsert(f.sourceId,{externalId:'unrelated',revision:'1',observedAt:'2026-09-20T00:00:00Z',kind:'file',layer:'original',text:'Generated unrelated raw recording export'});
 f.node.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(f.cards[0].id,other.id);
 assert.throws(()=>reader.assertMemoryReadable(f.cards),{statusCode:409});
 assert.deepEqual((await reader.memoryPageAsync({id:'memory:'+f.cards[0].id,includeStale:true,level:'detail'},false,undefined,{policy:new EvidenceExposurePolicy(),operation:'memory'})).items,[]);
});
test('a mixed direct raw proof still requires its own recording raw permission',async t=>{
 const f=await fixture(t,'feishu','read'),reader=f.node.featureServices.evidenceReader,card=f.node.memories.get(f.cards[0].id),raw=f.node.memories.readEvidence([f.rawId])[0];
 card.evidenceIds.push(raw.id);card.evidence.push({id:raw.id,deviceId:raw.deviceId,capturedAt:raw.capturedAt,receivedAt:raw.receivedAt,offset:0,length:raw.ocrText.length,quote:raw.ocrText,contentHash:memoryEvidenceFingerprint(raw)});
 f.node.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(card),card.id);
 assert.throws(()=>reader.assertMemoryReadable([card]),{statusCode:409});
});
test('private ancestors revoke the entire derived Memory while exact Material bodies still exist',async t=>{
 const f=await fixture(t,'feishu','read'),reader=f.node.featureServices.evidenceReader;
 f.node.store.db.prepare("UPDATE captures SET json=json_set(json,'$.privacy.excluded',json('true')) WHERE id=?").run(f.rawId);
 assert.throws(()=>reader.assertMemoryReadable(f.cards),{statusCode:409});
});
test('a frozen recording Memory snapshot rechecks current attribution before disclosing its old body',async t=>{
 const f=await fixture(t,'feishu','read'),reader=f.node.featureServices.evidenceReader,pin=f.node.memoryBindings.retainSnapshot();
 try{
  assert.ok(await reader.memoryAsync('memory:'+f.cards[0].id,{},false,pin));
  const material=f.node.materials.list({sourceId:f.sourceId}).items[0];f.node.materials.correctContext(material.id,material.revision,'third_party');
  assert.equal(await reader.memoryAsync('memory:'+f.cards[0].id,{},false,pin),undefined);
 }finally{pin.release();}
});

test('an explicitly retried window replaces its one receipt and deleting its lifecycle step cascades that receipt',async t=>{
 const f=await fixture(t,'feishu','skip'),window=f.view().active!;
 assert.equal(f.receipts().length,1);f.node.lifecycle.retry('consolidation',window.id);await f.node.lifecycle.tick();
 assert.equal(f.calls.filter(call=>call.skill==='memory-integration').length,2);assert.equal(f.receipts().length,1,'attempts do not append unbounded receipt rows');
 const row=f.node.store.db.prepare('SELECT step_id FROM memory_integration_deliveries').get()!;assert.equal(row.step_id,'lifecycle:'+window.id);
 f.node.store.db.prepare('DELETE FROM execution_steps WHERE id=?').run(String(row.step_id));assert.equal(f.receipts().length,0,'receipts share the durable lifecycle step lifetime');
});

test('actual app records native text handoff only after prepare succeeds, before independent review',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mote-native-integration-delivery-')),token='generated-native-delivery-owner';
 const config:Config={dataDir,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-native',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let release!:()=>void,entered!:()=>void,nativeCalls=0,reviewCalls=0;
 const preparing=new Promise<void>(resolve=>entered=resolve),accepted=new Promise<void>(resolve=>release=resolve);
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  assert.equal(input.traceContext?.phase,'review');reviewCalls++;
  const receipt=JSON.parse(String(node.store.db.prepare('SELECT json FROM memory_integration_deliveries').get()!.json));
  assert.deepEqual(receipt.memoryIds,[memory.id]);assert.deepEqual(receipt.evidenceIds,[original.id]);
  return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};
 }}});
 t.after(async()=>{release?.();await node.app.close();await rm(dataDir,{recursive:true,force:true});});
 node.sources.register({id:'generated-native-text',name:'Generated native text',kind:'custom',deviceId:'generated',platform:'import'});
 await node.sources.upsert('generated-native-text',{externalId:'one',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'The generated owner uses a silver telescope.'});
 await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);
 const material=node.materials.list({sourceId:'generated-native-text'}).items[0],original=node.memories.readEvidence(node.materials.evidenceIds(material.ref)).find(record=>record.ocrText.includes('silver telescope'))!;assert.ok(original);
 const saved=node.memories.extract(fixtureMemoryResult(node.memories,{answer:JSON.stringify({memories:[{title:'Generated native telescope',statement:`The generated owner uses a silver telescope. [${original.id}]`,uncertainty:'Generated fixture only',evidenceIds:[original.id]}]}),citations:[{id:original.id,capturedAt:original.capturedAt,appName:'Generated',excerpt:original.ocrText}],trace:[],runId:randomUUID()}),'generated').items[0],memory=node.memories.get(saved.id);
 generatedNativeAdapter(node,{prepare:async input=>{nativeCalls++;assert.equal(input.phase,'integrate');assert.deepEqual(input.relatedMemories?.map(card=>card.id),[memory.id]);entered();await accepted;return {answer:'{"memories":[]}',citations:[],trace:[],runId:input.opId};}});
 await node.app.ready();
 node.lifecycle.retirePending('extraction',Number(node.store.db.prepare('SELECT coalesce(max(seq),0) n FROM artifact_events').get()!.n));
 node.memoryPipeline.assertNewManualWork();node.memoryPipeline.assertAdmissibleEvidence([original.id]);assert.equal(memory.admission?.layer,'memory');assert.notEqual(memory.status,'stale');
 const request=await node.app.inject({method:'POST',url:'/api/memory-integrations',headers:{authorization:'Bearer '+token},payload:{recipe:{id:'mote.memory-integration',version:'2'},inputs:[{id:memory.id,version:memory.version,fingerprint:memory.fingerprint}]}});assert.equal(request.statusCode,202,request.body);
 await preparing;
 const pending=JSON.parse(String(node.store.db.prepare('SELECT json FROM memory_integration_deliveries').get()!.json));assert.deepEqual(pending.memoryIds,[]);assert.deepEqual(pending.evidenceIds,[],'local native arguments are not delivered originals');assert.equal(reviewCalls,0);
 release();await node.lifecycle.tick();
 const state=node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!;assert.equal(state.error,undefined);assert.equal(state.active,undefined);assert.equal(state.lastRun?.id,request.json().id);assert.equal(nativeCalls,1);assert.equal(reviewCalls,1);
 const delivered=JSON.parse(String(node.store.db.prepare('SELECT json FROM memory_integration_deliveries').get()!.json));assert.deepEqual(delivered.memoryIds,[memory.id]);assert.deepEqual(delivered.evidenceIds,[original.id]);
});
