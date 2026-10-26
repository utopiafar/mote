import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ContextReader,QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {larkDocumentJourneys,larkJourneyOwnerContext} from './fixtures/lark-document-journeys.js';
import {larkJourneyRunner} from './fixtures/lark-journey-runner.js';
import {fixtureMemoryPlan,generatedMemoryOutput} from './fixtures/memory-planning.js';

test('all nine generated document journeys use owner HTTP intake, automatic reviewed Memory, revision and restart without replay',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-lark-http-')),token='generated-lark-http-owner-token',headers={authorization:'Bearer '+token},upstream=larkJourneyRunner();
  const config:Config={dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const calls:QueryInput[]=[];
  // This provider is an explicit fixture: it verifies lifecycle and proof wiring,
  // not semantic interpretation or real Feishu coverage. Live quality is separate.
  const dependencies={backgroundWorker:false,connectorTesting:{lark:upstream.runner},createModelAgent:async(_settings:unknown,reader:ContextReader)=>({configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    const topic=fixtureTopicResult(input);if(topic)return topic;
    const plan=await fixtureMemoryPlan(input);if(plan)return plan;
    calls.push(input);
    const records=await reader.evidence({ids:input.evidenceIds??[]}),candidates=[];
    for(const record of records){
      const range=input.evidenceRanges?.find(item=>item.id===record.id);if(!range)continue;
      const fixture=larkDocumentJourneys.find(item=>item.selectedMemoryExpected&&item.document.content===record.ocrText);
      let activity=false;try{activity=Boolean(JSON.parse(record.ocrText).documentActivity);}catch{}
      if(!fixture&&!activity)continue;
      const quote=record.ocrText.slice(range.offset,range.offset+range.length);
      candidates.push({domain:'personal',kind:'episodic',title:fixture?.title??'Generated bounded activity',statement:`Generated fixture ${fixture?.id??'provider activity'} [${record.id}]`,uncertainty:'Deterministic fixture output; semantic quality is not assessed.',admission:{layer:activity?'observation':'memory',reason:'Generated acceptance fixture routing',scope:'Generated scenario only',attribution:activity?'observed':'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote,offset:range.offset}]});
    }
    return {answer:generatedMemoryOutput(input,candidates),citations:records.map(record=>({id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''})),trace:[],runId:randomUUID()};
  }})};
  let node=await buildApp(config,dependencies);await node.app.ready();await authorizeFixtureModels(node);t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const request=async(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:Record<string,unknown>)=>{
    const response=await node.app.inject({method,url,headers,...(payload?{payload}:{})});assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);return response.json();
  };
  const connectorDone=async()=>{for(let i=0;i<500;i++){const status=await request('GET','/api/connectors/lark');if(!['waiting','running'].includes(status.job?.state)){assert.equal(status.job?.state,'completed',JSON.stringify(status));return status;}await new Promise(resolve=>setTimeout(resolve,2));}throw Error('Generated connector did not settle');};
  const baselineJobIds=new Set<string>();
  const process=async()=>{
    for(let i=0;i<30;i++){await node.materialOrganizer.tick(100);if(!node.materialOrganizer.status().pendingChanges&&!node.materialOrganizer.status().pendingSteps)break;await new Promise(resolve=>setImmediate(resolve));}
    node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
    await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);
    for(const job of node.memoryPipeline.list())if(['queued','running','waiting_for_model'].includes(job.status))await node.memoryPipeline.run(job.id);
    const jobs=node.memoryPipeline.list().map(job=>node.memoryPipeline.get(job.id));assert.ok(jobs.length);
    const expectedInvalidation=(job:typeof jobs[number])=>baselineJobIds.has(job.id)&&job.status==='failed'&&job.batches.some(batch=>batch.status==='invalidated'&&batch.errorCode==='evidence_changed')&&job.batches.every(batch=>batch.status==='completed'||batch.status==='invalidated'&&batch.errorCode==='evidence_changed');
    assert.ok(jobs.every(job=>job.status==='completed'||expectedInvalidation(job)),JSON.stringify(jobs.map(job=>({id:job.id,status:job.status,batches:job.batches.map(batch=>({status:batch.status,errorCode:batch.errorCode}))}))));return jobs;
  };
  await request('POST','/api/connectors/lark/check');await request('POST','/api/connectors/lark/login');await connectorDone();
  const selection={documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false,documentDiscovery:{created:true,edited:true,opened:true,firstSyncDays:30},folders:[],wikiRoots:[],excludedDocuments:[]};
  await request('PUT','/api/connectors/lark/selection',selection);
  const source=node.sources.listSources().find(item=>item.kind==='lark-docs')!;assert.ok(source);
  const context=await request('GET',`/api/sources/${source.id}/context`);await request('PATCH',`/api/sources/${source.id}/context`,{expectedVersion:context.version,description:larkJourneyOwnerContext});
  await request('POST','/api/connectors/lark/preview');const preview=await connectorDone();assert.equal(preview.documentSync.previewTotal,9);assert.equal(node.sources.listItems({sourceId:source.id}).items.length,0);assert.equal(upstream.calls.some(call=>call.kind==='document'),false);
  await request('POST','/api/connectors/lark/sync');await connectorDone();for(const job of await process())baselineJobIds.add(job.id);
  const items=node.sources.listItems({sourceId:source.id,limit:100}).items;
  assert.equal(items.filter(item=>item.kind==='file').length,9);assert.equal(items.filter(item=>item.kind==='event').length,9);
  const selected=node.memories.list({layer:'memory',level:'detail'}),observations=node.memories.list({layer:'observation',level:'detail'});
  assert.equal(selected.length,3);assert.equal(observations.length,9);
  assert.ok([...selected,...observations].every(memory=>memory.reviewReceipt?.decision==='independent'));
  assert.ok(calls.some(call=>call.traceContext?.phase==='extract'));assert.ok(calls.some(call=>call.traceContext?.phase==='review'));
  for(const memory of [...selected,...observations])for(const span of memory.evidence){const original=node.memories.readEvidence([span.id])[0];assert.equal(original.ocrText.slice(span.offset,span.offset!+span.length!),span.quote);}
  upstream.advance();const changed=larkDocumentJourneys.find(item=>item.next)!;
  await request('PUT','/api/connectors/lark/selection',{...selection,documents:[`https://fixture.feishu.cn/docx/${changed.document.id}`]});
  await request('POST','/api/connectors/lark/preview');await connectorDone();await request('POST','/api/connectors/lark/sync');await connectorDone();await process();
  assert.equal(node.sources.history(source.id,changed.document.id).length,2);
  assert.equal(node.sources.getItem(source.id,changed.document.id)?.text,changed.next!.content);
  const after=calls.length,jobIds=node.memoryPipeline.list().map(job=>job.id).sort();
  await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();await process();
  assert.deepEqual(node.memoryPipeline.list().map(job=>job.id).sort(),jobIds);assert.equal(calls.length,after,'restart cannot fabricate new model work');
  await request('POST','/api/connectors/lark/sync');await connectorDone();await process();assert.equal(calls.length,after,'repeated overlapping discovery cannot fabricate another activity or body version');
});
