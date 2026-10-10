import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {uiPageText,type CaptureInput,type UiPageV2} from '@mote/shared';
import type {ContextRecord,QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {uiPageCaptureSource} from '../src/capture-memory-intake.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';

const token='generated-page-memory-owner-token-000000',headers={authorization:`Bearer ${token}`};
const personal={id:'mote.personal-memory',version:'2'},coding={id:'mote.coding-memory',version:'2'};
function record(kind:'article'|'product'='article',deviceId='generated-phone'):CaptureInput{
  const at='2026-10-10T00:00:00.000Z';
  const page:UiPageV2={version:2,scope:'visible_window',adapterId:'generated.fields',adapterVersion:'1',appVersion:'1',activity:'fixture.Page',status:'ok',truncated:false,
    observations:{firstAt:at,lastAt:at,count:1},objects:[{kind,title:kind==='article'?'Generated AI article':'Generated laptop card',
      ...(kind==='article'?{author:'Generated external author'}:{}),body:kind==='article'?[{text:'The article describes a generated AI context archive.'}]:[]}]};
  return {id:randomUUID(),deviceId,deviceName:'Generated phone',platform:'android',source:'ui_page',appId:'fixture.app',appName:'Generated App',capturedAt:at,durationMs:0,
    ocrText:uiPageText(page),privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'accessibility'},uiPage:page}};
}
async function fixture(t:TestContext,history?:CaptureInput){
  const directory=mkdtempSync(join(tmpdir(),'mote-page-memory-'));
  const config:Config={dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  if(history){const store=new Store(directory);await store.ingest(history);store.close();}
  const calls:{input:QueryInput;records:ContextRecord[]}[]=[],control:{empty?:boolean;review?:()=>Promise<void>}={};
  const dependencies={backgroundWorker:false,createModelAgent:async(_settings:unknown,reader:import('@mote/agent').ContextReader)=>({configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    if(await planGeneratedMemory(input))return {answer:'Generated packages submitted.',citations:[],trace:[],runId:randomUUID()};
    const records=await reader.evidence({ids:input.evidenceIds!});
    calls.push({input,records});
    assert.ok(records.length,'the real Memory reader must authorize the captured field body');
    if(input.traceContext?.phase==='review')await control.review?.();
    const first=records[0],range=input.evidenceRanges?.find(range=>range.id===first.id),quote=range?first.ocrText.slice(range.offset,range.offset+range.length):first.ocrText;
    const memories=control.empty?[]:[{title:'Generated page observation',statement:`The generated device displayed this captured page [${first.id}]. Purchase and finished reading are unestablished.`,uncertainty:'A generated visible-window observation only.',
      admission:{layer:'observation',reason:'A bounded event for daily recall',scope:'Generated device at the capture time',attribution:'observed'},evidenceIds:[first.id],evidence:[{id:first.id,quote,offset:range?.offset??0}]}];
    return {answer:generatedMemoryOutput(input,memories),citations:memories.length?[{id:first.id,capturedAt:first.capturedAt,appName:first.appName,excerpt:quote}]:[],trace:[],runId:randomUUID()};
  }})};
  let node=await buildApp(config,dependencies);await node.app.ready();
  // Isolate the original intake contract; dedicated daily-event journeys exercise the new default.
  const selected=await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers,payload:{scope:'capture',recipes:[personal]}});assert.equal(selected.statusCode,200,selected.body);
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const publish=async()=>{for(let i=0;i<10;i++)if(await node.materialOrganizer.tick(100)===0)break;};
  const run=async()=>{
    node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
    await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);
    for(const job of node.memoryPipeline.list())if(['queued','running','waiting_for_model'].includes(job.status))await node.memoryPipeline.run(job.id);
  };
  const ingest=async(value:CaptureInput,status=201)=>{const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:value});assert.equal(response.statusCode,status,response.body);};
  const configure=async(recipes:typeof personal[],sourceId?:string)=>{const response=await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers,payload:{recipes,...(sourceId?{sourceId}:{})}});assert.equal(response.statusCode,200,response.body);};
  return {get node(){return node;},calls,control,publish,run,ingest,configure,async restart(){await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();}};
}

test('bundled article and product intake survives restart, automatically extracts and independently reviews, retaining raw query evidence',async t=>{
  const f=await fixture(t),article=record(),product=record('product');
  const response=await f.node.app.inject({method:'POST',url:'/api/captures/bundle',headers:{...headers,'content-type':'application/x-ndjson+gzip'},payload:gzipSync([article,product].map(value=>JSON.stringify(value)).join('\n'))});
  assert.equal(response.statusCode,200,response.body);assert.ok(response.json().results.every((result:{status:number})=>result.status===201));
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE authorized=1').get()!.n,2);
  await f.publish();assert.equal(f.calls.length,0,'publication alone does not call a model');
  const materials=f.node.materials.list({kind:'mote.ui-page-object'}).items;assert.equal(materials.length,2);
  assert.ok(materials.every(material=>material.coverage.state==='partial'));
  for(const material of materials){
    assert.equal(f.node.featureServices.evidenceReader.materialAllowedForMemory(material.ref,new EvidenceExposurePolicy(),['source-body']),true);
    assert.equal(f.node.featureServices.evidenceReader.materialAllowedForMemory(material.ref,new EvidenceExposurePolicy(),['material']),false,'visible fields do not grant complete-document input');
    assert.equal(f.node.featureServices.evidenceReader.materialAllowedForMemory(material.ref,new EvidenceExposurePolicy([{sourceId:material.origin.sourceId,operation:'memory',allow:false}]),['source-body']),false,'ready field text never overrides an explicit privacy policy');
  }
  await f.restart();await f.publish();await f.run();
  const jobs=f.node.memoryPipeline.list().map(job=>f.node.memoryPipeline.get(job.id));assert.ok(jobs.length);assert.ok(jobs.every(job=>job.status==='completed'),JSON.stringify(jobs));
  assert.equal(f.calls.filter(call=>call.input.traceContext?.phase==='extract').length,1,'ordinary fields use the existing bounded package');
  assert.equal(f.calls.filter(call=>call.input.traceContext?.phase==='review').length,1);
  const memories=jobs.flatMap(job=>job.memoryIds.map(id=>f.node.memories.get(id)));assert.ok(memories.length);assert.ok(memories.every(memory=>memory.status==='published'&&memory.admission.layer==='observation'&&memory.reviewReceipt?.decision==='independent'),JSON.stringify(memories));
  for(const value of [article,product]){
    const original=f.node.store.evidence([value.id])[0];assert.equal(original.ocrText,value.ocrText);assert.deepEqual(original.metadata?.uiPage,value.metadata?.uiPage);
    assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM perception_jobs WHERE capture_id=?').get(value.id)!.n,0);
    assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM image_inputs WHERE capture_id=?').get(value.id)!.n,0);
  }
  const queryReader=f.node.featureServices.evidenceReader.agent({diagnostics:f.node.diagnostics,currentGrantContext:()=>queryContext}),queryContext={};
  const catalog=await queryReader.materialCatalog!({kind:'mote.ui-page-object'});assert.equal(catalog.items.length,2);
  const page=await queryReader.materialRead!({ref:catalog.items[0].ref,length:4000});assert.match(page.text,/Generated/);
  const originals=await queryReader.evidence({ids:page.originalRefs.map(ref=>ref.slice('capture:'.length))});assert.ok(originals.some(value=>value.metadata?.uiPage));
  const calls=f.calls.length;await f.ingest(article,200);await f.ingest(product,200);await f.restart();await f.publish();await f.run();assert.equal(f.calls.length,calls,'ACK replay and restart do not repeat completed model work');
});

test('old field originals remain queryable without retroactive authorization; new arrivals use receipt-pinned source recipes',async t=>{
  const old=record(),f=await fixture(t,old);await f.publish();await f.ingest(old,200);await f.run();assert.equal(f.calls.length,0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations').get()!.n,0);
  const first=record();await f.ingest(first);const sourceId=uiPageCaptureSource(first.deviceId);
  await f.configure([coding],sourceId);await f.publish();await f.run();assert.equal(f.calls.length,0,'changing recipes revokes the prior input rather than granting another recipe');
  const next=record('product');await f.ingest(next);await f.publish();await f.run();
  const jobs=f.node.memoryPipeline.list().map(job=>f.node.memoryPipeline.get(job.id));assert.ok(jobs.length);assert.ok(jobs.every(job=>job.recipes?.[0].id===coding.id));
  assert.ok(f.node.materials.list({kind:'mote.ui-page-object'}).items.length>=3,'original materials survive recipe changes');
  assert.equal(f.node.store.evidence([old.id])[0].ocrText,old.ocrText);
});

test('zero candidates are independently reviewed and checked once, rather than forcing browsing into a personal fact',async t=>{
  const f=await fixture(t);f.control.empty=true;await f.ingest(record('product'));await f.publish();await f.run();
  const jobs=f.node.memoryPipeline.list().map(job=>f.node.memoryPipeline.get(job.id));assert.ok(jobs.length);assert.ok(jobs.every(job=>job.status==='completed'&&job.memoryCount===0));
  assert.equal(f.calls.filter(call=>call.input.traceContext?.phase==='review').length,1);assert.equal(f.node.memories.list().length,0);
  const calls=f.calls.length;await f.run();assert.equal(f.calls.length,calls);
});

test('deleting a field original during independent review fences publication and removes its material',async t=>{
  const f=await fixture(t),value=record();await f.ingest(value);await f.publish();
  f.control.review=async()=>{const response=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+value.id,headers});assert.equal(response.statusCode,200,response.body);};
  await f.run();await f.publish();assert.ok(f.calls.some(call=>call.input.traceContext?.phase==='review'));
  assert.equal(f.node.memories.list().length,0);assert.equal(f.node.store.evidence([value.id]).length,0);assert.equal(f.node.materials.list({kind:'mote.ui-page-object'}).items.length,0);
});

test('changing page recipes during independent review cancels the old authority while retaining queryable originals',async t=>{
  const f=await fixture(t),value=record();await f.ingest(value);await f.publish();
  f.control.review=async()=>{await f.configure([coding],uiPageCaptureSource(value.deviceId));};
  await f.run();assert.ok(f.calls.some(call=>call.input.traceContext?.phase==='review'));
  assert.equal(f.node.memories.list().length,0);assert.equal(f.node.store.evidence([value.id])[0].ocrText,value.ocrText);
  assert.equal(f.node.materials.list({kind:'mote.ui-page-object'}).items.length,1);
  const calls=f.calls.length;await f.restart();await f.publish();await f.run();assert.equal(f.calls.length,calls,'new recipe selection does not authorize the old page after restart');
});
