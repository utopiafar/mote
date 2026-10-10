import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ContextReader,QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {MemoryRecipeSettings} from '../src/memory-recipe-settings.js';
import {DAILY_EVENT_RECIPE} from '../src/daily-event-memory-policy.js';
import {uiPageCaptureSource} from '../src/capture-memory-source.js';
import {screenImageSource} from '../src/image-inputs.js';
import {sha256} from '../src/store.js';
import {dailyEventFixtures} from './fixtures/daily-events.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';

const personal={id:'mote.personal-memory',version:'2'},coding={id:'mote.coding-memory',version:'2'};
test('capture defaults preserve explicit selections, only authorize future input, and retain an owner-disabled event recipe after restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-daily-defaults-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new Store(dir),strategies=new MemoryStrategies(),settings=new MemoryRecipeSettings(store,strategies);
  const sourceId=uiPageCaptureSource('generated'),screenId=screenImageSource('generated',sha256);
  for(const id of [sourceId,screenId,'ordinary'])store.db.prepare('INSERT INTO source_connections VALUES(?,?)').run(id,JSON.stringify({id,deviceId:'generated'}));
  assert.deepEqual(settings.selection().map(b=>b.recipe.id),[personal.id]);
  for(const id of [sourceId,screenId])assert.deepEqual(settings.selection(id).map(b=>b.recipe.id),[personal.id,DAILY_EVENT_RECIPE.id]);
  assert.deepEqual(settings.selection('ordinary').map(b=>b.recipe.id),[personal.id]);
  settings.configure({sourceId,recipes:[coding]});settings.configure({scope:'capture',recipes:[DAILY_EVENT_RECIPE]});
  assert.deepEqual(settings.selection(sourceId).map(b=>b.recipe.id),[coding.id],'capture defaults never replace a saved source override');
  settings.configure({scope:'capture',recipes:[personal]});store.close();
  store=new Store(dir);t.after(()=>store.close());strategies=new MemoryStrategies();settings=new MemoryRecipeSettings(store,strategies);
  assert.deepEqual(settings.selection(screenId).map(b=>b.recipe.id),[personal.id],'restart must not re-enable events');
  assert.deepEqual(settings.selection(sourceId).map(b=>b.recipe.id),[coding.id]);
  settings.configure({sourceId,recipes:null});assert.deepEqual(settings.selection(sourceId).map(b=>b.recipe.id),[personal.id]);
});

test('generated screenshot and field HTTP intake runs daily extraction/review, supports local-day original-backed recall and preserves replay/delete fences',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-daily-journey-')),token='generated-daily-owner-token',headers={authorization:'Bearer '+token},data=await dailyEventFixtures();
  const config:Config={dataDir:dir,token,tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const calls:QueryInput[]=[];
  const dependencies={backgroundWorker:false,createModelAgent:async(_settings:unknown,reader:ContextReader)=>({configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    calls.push(input);
    if(input.directImages){const id=input.directImages[0].id;await reader.readImage!({id});return {answer:JSON.stringify({text:data.ocr.get(id),regions:[]}),citations:[],trace:[],runId:randomUUID()};}
    const records=await reader.evidence({ids:input.evidenceIds!});assert.ok(records.length);
    const daily=input.question.includes('daily event history');
    // The deterministic provider proves contracts/routing, not semantic quality.
    const candidates=daily?records.map(record=>{const range=input.evidenceRanges!.find(span=>span.id===record.id)!;const quote=record.ocrText.slice(range.offset,range.offset+range.length);return {domain:'personal',kind:'episodic',title:'Generated dated event',statement:`Captured event at ${record.capturedAt}; action/outcome is limited to displayed proof [${record.id}]`,uncertainty:'Generated visible scope; no claim of endorsement, ownership or unshown completion.',admission:{layer:'observation',reason:'Daily recall of this dated display',scope:record.capturedAt,attribution:'observed'},evidenceIds:[record.id],evidence:[{id:record.id,quote,offset:range.offset}]};}):[];
    return {answer:generatedMemoryOutput(input,candidates),citations:records.filter(record=>daily).map(record=>({id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''})),trace:[],runId:randomUUID()};
  }})};
  let node=await buildApp(config,dependencies);await node.app.ready();t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const setup=()=>{node.processing.configureImageDefault({endpoint:'http://127.0.0.1:9011/ocr'});node.processing.runtime.registry.get('image.http').process=async input=>({durationMs:0,segments:[{startMs:0,endMs:0,text:data.ocr.get(input.file.id)!}]});};setup();
  const publish=async()=>{await node.perception.tick();for(let i=0;i<20;i++)if(await node.materialOrganizer.tick(100)===0)break;};
  const run=async()=>{node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);for(const job of node.memoryPipeline.list())if(['queued','running','waiting_for_model'].includes(job.status))await node.memoryPipeline.run(job.id);};
  for(const value of data.all){const r=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:value});assert.equal(r.statusCode,201,r.body);}
  await publish();await run();
  const jobs=node.memoryPipeline.list().map(job=>node.memoryPipeline.get(job.id));assert.ok(jobs.every(job=>job.status==='completed'),JSON.stringify(jobs));
  const events=node.memories.list({layer:'observation',level:'detail'});assert.ok(events.length>=data.all.length);
  assert.ok(events.every(event=>event.strategy?.recipe.id===DAILY_EVENT_RECIPE.id&&event.reviewReceipt?.decision==='independent'));
  assert.ok(calls.some(call=>call.traceContext?.phase==='extract'&&call.question.includes('daily event history')));assert.ok(calls.some(call=>call.traceContext?.phase==='review'&&call.question.includes('daily-event policy')));
  const reader=node.featureServices.evidenceReader.agent({diagnostics:node.diagnostics,currentGrantContext:()=>grant}),grant={};
  const screenshot=data.all.find(capture=>capture.imageBase64)!;
  assert.deepEqual(await reader.evidence({ids:[screenshot.id]}),[],'derived event recall does not grant arbitrary raw screenshot expansion');
  const previous=await reader.memories!({layer:'observation',after:'2026-10-08T16:00:00Z',before:'2026-10-09T16:00:00Z'});
  const today=await reader.memories!({layer:'observation',after:'2026-10-09T16:00:00Z',before:'2026-10-10T16:00:00Z'});
  assert.ok(previous.items.length);assert.ok(today.items.length);const oldIds=new Set(previous.items.map((v:any)=>v.id));assert.ok(today.items.every((v:any)=>!oldIds.has(v.id)),'adjacent local days remain separately recallable');
  const detail=await reader.memories!({id:(today.items[0] as any).id,includeEvidence:true});assert.ok(detail.sourceSpans?.length,'recap receives current verified original proof');
  assert.deepEqual(await reader.evidence({ids:[screenshot.id]}),[],'verified memory proof does not create a raw screenshot grant');
  for(const event of events)for(const span of event.evidence){const original=node.memories.readEvidence([span.id])[0];assert.equal(original.ocrText.slice(span.offset,span.offset!+span.length!),span.quote);}
  for(const value of data.all){assert.ok(node.store.evidence([value.id]).length);if(value.imageBase64)assert.ok(node.store.image(value.id));else assert.deepEqual(node.store.evidence([value.id])[0].metadata?.uiPage,value.metadata?.uiPage);}
  const before=calls.length;await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();setup();
  for(const value of data.all){const r=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:value});assert.equal(r.statusCode,200,r.body);}await publish();await run();assert.equal(calls.length,before);
  const removed=await node.app.inject({method:'DELETE',url:'/api/captures/'+data.article.id,headers});assert.equal(removed.statusCode,200,removed.body);await publish();
  assert.equal(node.store.evidence([data.article.id]).length,0);assert.ok(node.memories.list({layer:'observation',level:'detail'}).every(memory=>!memory.evidenceIds.some(id=>node.memories.dependencyIds(id).includes(data.article.id))));
});
