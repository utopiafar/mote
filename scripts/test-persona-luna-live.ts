/** Opt-in: generated 45-day archive; authored-journal extraction and full-archive query, local Luna Max only. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {DatabaseSync,backup} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';
import {personaFixture} from './fixtures/persona.js';

const recoveryDirectory=process.env.MOTE_PERSONA_RECOVERY_VAULT;
const retryJobId=process.env.MOTE_PERSONA_RETRY_JOB_ID,allowPartial=process.env.MOTE_PERSONA_ALLOW_PARTIAL==='1';
const fixture=personaFixture(),directory=await mkdtemp(join(tmpdir(),'mote-persona-luna-')),token=randomBytes(32).toString('hex');
const reportPath=process.env.MOTE_PERSONA_REPORT??join(tmpdir(),'mote-persona-luna-report.json');
const config:Config={dataKey:undefined,dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:200_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-5.6-luna',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'info',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:3};
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const report:Record<string,unknown>={persona:fixture.persona,days:fixture.days,recordsPerDay:fixture.recordsPerDay,records:fixture.records.length,model:config.model,reasoningEffort:'max',personalDataUsed:false,physicalDevicesTested:false,liveExtractionScope:'All 45 authored journal records; 1,035 passive observations remain searchable originals, not passed through live extraction.',startedAt:new Date().toISOString()};
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
try{
 if(recoveryDirectory){
  const source=new DatabaseSync(join(recoveryDirectory,'mote.sqlite'),{readOnly:true});
  try{
   const expected=new Map(fixture.records.map(record=>[record.sourceId+':'+record.item.externalId,record.item.text]));
   const rows=source.prepare('SELECT json,blob_hash FROM captures').all();assert.equal(rows.length,fixture.records.length,'Recovery vault must contain only the generated Persona fixture');
   for(const row of rows){const record=JSON.parse(String(row.json)),key=record.provenance?.sourceId+':'+record.provenance?.externalId;assert.ok(expected.has(key));assert.equal(record.ocrText,expected.get(key));assert.equal(row.blob_hash,null);expected.delete(key);}
   assert.equal(expected.size,0);await backup(source,join(directory,'mote.sqlite'));
  }finally{source.close();}
 }
 node=await buildApp(config);
 const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 assert.equal(node.modelSettings.current().model,'gpt-5.6-luna');assert.equal(node.modelSettings.current().reasoningEffort,'max');
 for(const sourceId of ['persona-journal','persona-observations'])node.sources.register({id:sourceId,name:sourceId==='persona-journal'?'林舟工作日志（合成）':'窗口观察（合成）',kind:'custom',deviceId:'synthetic-persona',platform:'import'});
 const journalIds:string[]=[],journalOriginals:unknown[]=[],anchors:Record<string,string>={},ingestStarted=performance.now();
 for(const record of fixture.records){const ack=await node.sources.upsert(record.sourceId,record.item);if(record.sourceId==='persona-journal'){journalIds.push(ack.id);journalOriginals.push({id:ack.id,...record});}if(record.key)anchors[record.key]=ack.id;}
 report.journalOriginals=journalOriginals;
 report.ingestMs=Math.round(performance.now()-ingestStarted);report.anchors=anchors;
 assert.equal(node.store.list({after:fixture.authoredAfter,before:fixture.authoredBefore,limit:1}).totalCount,1080);
 console.log(JSON.stringify({stage:'seeded',records:1080,journalRecords:journalIds.length,ingestMs:report.ingestMs}));await save();
 const extractionIds=retryJobId?node.memoryPipeline.get(retryJobId).evidenceIds:recoveryDirectory?journalIds.filter(id=>!node!.store.db.prepare('SELECT 1 FROM memory_checkpoints WHERE evidence_id=?').get(id)):journalIds;
 report.recovery=retryJobId?{kind:'production-bounded-retry',previouslyCompletedJournalRecords:new Set(node.memoryPipeline.get(retryJobId).batches.filter(batch=>batch.status==='completed').flatMap(batch=>batch.evidenceRanges.map(range=>range.id))).size,retriedJournalRecords:node.memoryPipeline.get(retryJobId).batches.filter(batch=>batch.status==='failed').flatMap(batch=>batch.evidenceRanges).length,maxSplitDepth:2}:recoveryDirectory?{kind:'smaller-new-job',previouslyCompletedJournalRecords:journalIds.length-extractionIds.length,remainingJournalRecords:extractionIds.length,batchCharacters:256}:undefined;
 report.preexistingMemoryCount=Number(node.store.db.prepare('SELECT count(*) n FROM memories').get()!.n);
 assert.ok(extractionIds.length>0,'No unfinished journals in the supplied recovery snapshot');
 if(retryJobId){
  assert.ok(recoveryDirectory);const priorPath=process.env.MOTE_PERSONA_PRIOR_REPORT;assert.ok(priorPath,'A preserved measured deadline report is required');const prior=JSON.parse(await readFile(priorPath,'utf8'));
  assert.equal(prior.personalDataUsed,false);assert.equal(prior.extraction.status,'failed');assert.equal(prior.model,'gpt-5.6-luna');assert.equal(prior.reasoningEffort,'max');
  const original=node.memoryPipeline.get(retryJobId),failed=original.batches.filter(batch=>batch.status==='failed');assert.equal(failed.length,1);assert.equal(prior.extraction.batches[failed[0].index].errorCode,'provider_failed');
  // Test-snapshot migration only: the preserved trace measured a 300s host
  // deadline before the adapter retained typed timeout causes. Originals,
  // ranges, checkpoint keys, successful batches and original report are intact.
  node.store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.errorCode','provider_timeout') WHERE id=?").run(failed[0].id);
  node.store.db.prepare("UPDATE execution_steps SET error='provider_timeout' WHERE id=? AND state='failed'").run(failed[0].id);
  node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.errorCode','provider_timeout') WHERE id=?").run(retryJobId);
  report.restoredTimeout={originalReport:priorPath,oldCode:'provider_failed',restoredCode:'provider_timeout',observedDeadlineMs:300000,originalBatchRanges:failed[0].evidenceRanges,originalBatchAttempts:failed[0].attempts,explanation:'Test snapshot restores the measured legacy deadline cause; this is a production retry/split validation, not a fresh default run.'};
 }
 const extractionStarted=performance.now();let job=retryJobId?await node.memoryPipeline.retry(retryJobId):await node.memoryPipeline.run(node.memoryPipeline.create({evidenceIds:extractionIds,timeZone:'Asia/Shanghai',...(recoveryDirectory?{batchCharacters:256}:{})}).id);
 report.initialExtraction={status:job.status,batches:job.batches.map(batch=>({status:batch.status,errorCode:batch.errorCode,attempts:batch.attempts}))};await save();
 if(!retryJobId&&job.status==='failed'&&job.batches.some(batch=>['provider_failed','provider_network','provider_timeout','model_failed'].includes(batch.errorCode??''))){const delay=Math.max(0,(job.availableAt??0)-Date.now());assert.ok(delay<=60000,'Provider retry window exceeds the bounded evaluation wait');console.log(JSON.stringify({stage:'retry-failed-batches',retryDelayMs:delay,initialExtraction:report.initialExtraction}));if(delay)await new Promise(resolve=>setTimeout(resolve,delay+10));job=await node.memoryPipeline.retry(job.id);}
 report.extraction={durationMs:Math.round(performance.now()-extractionStarted),status:job.status,totalBatches:job.totalBatches,completedBatches:job.completedBatches,failedBatches:job.failedBatches,batches:job.batches.map(batch=>({status:batch.status,attempts:batch.attempts,errorCode:batch.errorCode,splitDepth:batch.splitDepth,splitHistory:batch.splitHistory,validationFailures:batch.validationFailures}))};
 const memoryIds=recoveryDirectory?node.store.db.prepare('SELECT id FROM memories').all().map(row=>String(row.id)):job.memoryIds;
 report.memories=memoryIds.map(id=>node!.memories.get(id));await save();
 if(!allowPartial)assert.equal(job.status,'completed',JSON.stringify(report.extraction));assert.equal(job.pendingBatches,0);assert.equal(job.runningBatches,0);
 const episodes=memoryIds.map(id=>node!.memories.get(id)),durable=episodes.filter(memory=>memory.admission?.layer==='memory'),covered=new Set(durable.flatMap(memory=>memory.evidenceIds));
 for(const memory of episodes){assert.ok(memory.reviewReceipt);for(const evidence of memory.evidence??[]){const original:import('@mote/shared').CaptureRecord=node.store.evidence([evidence.id])[0];assert.equal(original.ocrText.slice(evidence.offset!,evidence.offset!+evidence.length!),evidence.quote);}}
 const required=['outbox-decision','retention-revised','verified-recovery','preference-revised'];
 assert.ok(durable.every(memory=>memory.evidenceIds.some(id=>id!==anchors['third-party']&&id!==anchors.injection)), 'A third-party fitness fact or attack string alone became durable personal memory');
 const expiredResource=durable.filter(memory=>memory.evidenceIds.includes(anchors['temporary-resource']));for(const memory of expiredResource){assert.ok(memory.validUntil,'Explicit temporary resource expiry was not stored');assert.equal(node.memories.page({id:memory.id,asOf:'2026-09-20T00:00:00Z'}).items.length,1);assert.equal(node.memories.page({id:memory.id,asOf:'2026-09-22T00:00:00Z'}).items.length,0);}
 report.quality={explicitExpiryEnforced:expiredResource.length>0,rejectedNoiseOnlyMemories:true,requiredAnchorCoverage:Object.fromEntries(required.map(key=>[key,covered.has(anchors[key])])),durableMemories:durable.length,allQuotesExact:true,independentReviewPresent:true};
 assert.ok(required.every(key=>covered.has(anchors[key])),JSON.stringify(report.quality));
 if(job.status==='completed'&&!retryJobId)assert.equal(node.memoryPipeline.create({evidenceIds:extractionIds}).totalBatches,0);
 report.completedJournalRecords=journalIds.filter(id=>node!.store.db.prepare('SELECT 1 FROM memory_checkpoints WHERE evidence_id=?').get(id)).length;
 if(!allowPartial)assert.equal(report.completedJournalRecords,45,'Not every authored journal completed extraction');
 console.log(JSON.stringify({stage:'extracted',...report.extraction as object,...report.quality as object}));await save();
 settings.consolidation={...settings.consolidation,enabled:true,minChanges:1,maxItems:50};node.lifecycle.configure(settings);
 const consolidationStarted=performance.now();await node.lifecycle.tick();
 const consolidation=node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!;
 report.memoriesAfterConsolidation=node.store.db.prepare('SELECT id FROM memories').all().map(row=>node!.memories.get(String(row.id)));
 report.activeMemoryIds=node.memories.page({limit:100}).items.map(memory=>memory.id);
 report.consolidation={durationMs:Math.round(performance.now()-consolidationStarted),state:consolidation,memories:node.memories.page({tier:'consolidated',includeHistory:true,level:'detail',limit:100}).items};await save();
 if(!allowPartial){assert.equal(consolidation.failures,0,JSON.stringify(report.consolidation));assert.ok(consolidation.lastRun);}
 console.log(JSON.stringify({stage:'consolidated',durationMs:(report.consolidation as {durationMs:number}).durationMs,count:(report.consolidation as {memories:unknown[]}).memories.length}));
 settings.consolidation.enabled=false;node.lifecycle.configure(settings);
 const started=performance.now(),response=await node.app.inject({method:'POST',url:'/api/query',headers:{authorization:`Bearer ${token}`},payload:{question:'回顾林舟在 8 月 1 日至 9 月 14 日的 ORBIT 项目：哪些同步设计、保留期限和评审安排发生过变化，理由与验证结果是什么？9 月 10 日与明澈的演练确认完成了吗？请优先查看记忆，再核对原始证据；只陈述这个项目及确有归属的事实，给出可追溯引用。',after:fixture.authoredAfter,before:fixture.authoredBefore,timeZone:'Asia/Shanghai'}});
 assert.equal(response.statusCode,200,response.body);const result=response.json();
 report.query={durationMs:Math.round(performance.now()-started),...result};await save();
 assert.equal(result.modelSelection.model,'gpt-5.6-luna');assert.equal(node.modelSettings.current().reasoningEffort,'max');
 assert.ok(result.trace.some((step:{tool:string})=>step.tool==='memories'));assert.ok(result.trace.some((step:{tool:string})=>step.tool==='evidence'));
 assert.ok(result.citations.some((citation:{id:string})=>citation.id===anchors['retention-revised']));assert.ok(result.citations.some((citation:{id:string})=>citation.id===anchors['open-outcome']||citation.id===anchors['proposal-only']));
 assert.equal(node.store.list({after:fixture.authoredAfter,before:fixture.authoredBefore,limit:1}).totalCount,1080,'Read-only query changed the original archive');
 report.finishedAt=new Date().toISOString();report.status=job.status==='completed'&&consolidation.failures===0?'passed':'partial';await save();if(report.status==='partial')process.exitCode=1;console.log(JSON.stringify({stage:'query-complete',status:report.status,durationMs:(report.query as {durationMs:number}).durationMs,reportPath,answer:result.answer}));
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);if(node)report.diagnostics=node.diagnostics.events(0,500).items.filter(event=>event.event==='agent.failed'||event.event==='agent.tool_rejected'||event.event==='agent.memory_validation_failed');await save();throw error;}
finally{await node?.app.close();await rm(directory,{recursive:true,force:true});}
