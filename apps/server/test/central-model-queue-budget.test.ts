import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

for(const entry of ['ask','insight'] as const)test(`the real Central ${entry} entry waits beyond its model budget for a model slot`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-central-model-wait-')),token='generated-queue-budget-token';let calls=0;
 const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1/v1',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTimeoutMs:5000,llmConcurrency:1,interactiveConcurrency:1};
 // Use the actual host model callback and its lane gate. Only the final model
 // answer is synthetic: no private input, network service or provider is used.
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,_reader,host)=>({configured:true,close:async()=>{},query:input=>host!.runModel!(async()=>{calls++;return {answer:input.skill==='personal-insight'?JSON.stringify({title:'Generated review',markdown:'Generated review',html:'<p>Generated review</p>'}):'Generated answer',citations:[],trace:[],runId:randomUUID()};},input.signal)})});
 await node.app.ready();const held=deferred(),entered=deferred(),gate=entry==='ask'?node.featureServices.interactiveModelGate:node.featureServices.llmGate;
 const blocker=gate.run(async()=>{entered.resolve();await held.promise;});await entered.promise;
 t.after(async()=>{held.resolve();await blocker;await node.app.close();rmSync(directory,{recursive:true,force:true});});
 t.mock.timers.enable({apis:['setTimeout']});
 const response=node.app.inject({method:'POST',url:entry==='ask'?'/api/query':'/api/insights',headers:{authorization:'Bearer '+token},payload:entry==='ask'?{question:'Generated queued question'}:{prompt:'Generated queued review'}});
 const result=Promise.resolve(response);
 for(let index=0;index<100&&gate.snapshot().waiting===0;index++)await turn();
 assert.equal(gate.snapshot().waiting,1);assert.equal(calls,0);
 t.mock.timers.tick(5001);await turn();assert.equal(gate.snapshot().waiting,1,'model capacity waiting is not task processing');assert.equal(calls,0);
 held.resolve();await blocker;const completed=await result;
 assert.equal(completed.statusCode,200,completed.body);assert.equal(calls,1);
 assert.equal(entry==='ask'?node.featureServices.queryRuns.list()[0].status:node.insightRuns.list()[0].status,'completed');
});

for(const stage of ['semantic grouping','summary'] as const)test(`the real Central file ${stage} waits beyond the file transport timeout for a model slot`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-file-model-wait-'));let calls=0,asrCalls=0,diarizeCalls=0;
 const config:Config={dataDir:directory,token:'generated-file-queue-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1/v1',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTimeoutMs:5000,llmConcurrency:1};
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader,host)=>({configured:true,close:async()=>{},query:input=>host!.runModel!(async()=>{
   calls++;const {items}=await reader.timeline({limit:20});
   return {answer:stage==='semantic grouping'?JSON.stringify({groups:[[0]]}):'Generated file summary',citations:items.map(record=>({id:record.id,capturedAt:'2026-01-01T00:00:00.000Z',appName:'Generated file',excerpt:'Generated audio evidence'})),trace:[],runId:randomUUID()};
 },input.signal)})});
 await node.app.ready();
 const audio=node.processing.runtime.registry.register({id:'fixture.queue-audio',name:'Generated audio',version:'1',stage:'extract',serviceKind:'asr',localOnly:true,dialogue:stage==='semantic grouping',mediaTypes:['audio/'],parameters:[{key:'semanticTurns',label:'Generated semantic grouping',type:'boolean',default:false}],async process(){asrCalls++;return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated audio evidence'}]};}});
 const diarizer=node.processing.runtime.registry.register({id:'fixture.queue-diarizer',name:'Generated diarizer',version:'1',stage:'diarize',localOnly:true,mediaTypes:['audio/'],async process(){diarizeCalls++;return {durationMs:1000,engine:'generated',expectedSpeakers:null,observedSpeakers:1,overlapDetection:'unknown',segments:[{startMs:0,endMs:1000,speaker:'SPEAKER_0'}],samples:[]};}});
 const settings={...node.processing.currentSettings(),enabled:true,audioProcessor:'fixture.queue-audio',diarizationProcessor:'fixture.queue-diarizer',semanticTurns:stage==='semantic grouping',summarize:stage==='summary',timeoutMs:1000};
 await node.processing.save({revision:node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,node.processing.runtime.registry)});
 await authorizeFixtureModels(node);node.featureHost.stop();
 node.sources.register({id:'generated-file-queue',name:'Generated file queue',kind:'local-files',deviceId:'generated-file-queue',platform:'android',retention:'archive'});
 const bytes=Buffer.alloc(76);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(32,40);
 const upload=node.files.begin({sourceId:'generated-file-queue',item:{externalId:'generated.wav',revision:'1',observedAt:new Date().toISOString(),title:'Generated queued audio',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const id=(await node.files.commit(upload.uploadId,()=>{})).id;
 const held=deferred(),entered=deferred(),gate=node.featureServices.llmGate,blocker=gate.run(async()=>{entered.resolve();await held.promise;});await entered.promise;
 t.after(async()=>{held.resolve();await blocker;await node.app.close();audio();diarizer();rmSync(directory,{recursive:true,force:true});});
 const processing=node.processing.tick();
 for(let index=0;index<200&&gate.snapshot().waiting===0;index++)await turn();
 assert.equal(gate.snapshot().waiting,1);assert.equal(calls,0);
 // AbortSignal.timeout uses Node's real timer; retain a real wait to cover both
 // the engine deadline and the issued-call ledger's former transport deadline.
 await new Promise<void>(resolve=>setTimeout(resolve,1100));
 assert.equal(gate.snapshot().waiting,1,'model admission outlives the configured file transport deadline');assert.equal(calls,0);
 assert.equal(node.processing.cancellation(id).wait,'running');
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM file_processor_waits WHERE state='unknown'").get()!.n,0);
 assert.equal(node.executor.list({operationId:'file:'+id,limit:100}).items.filter(step=>step.state==='failed').length,0);
 held.resolve();await blocker;await processing;
 const detail=node.files.detail(id);assert.equal(detail.job.state,'succeeded');assert.equal(calls,1);assert.equal(asrCalls,1);assert.equal(diarizeCalls,stage==='semantic grouping'?1:0);
 if(stage==='summary')assert.equal(detail.job.summary_state,'succeeded');
 else assert.ok(detail.artifacts.some(artifact=>artifact.kind==='dialogue'&&artifact.semanticGrouping===true));
 assert.equal(node.processing.cancellation(id).wait,null);assert.equal(detail.hasOriginal,true);
});
