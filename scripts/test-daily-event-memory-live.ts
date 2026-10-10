/** Opt-in generated screenshots/fields; real Codex extraction, review and recap. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';
import {DAILY_EVENT_RECIPE} from '../apps/server/src/daily-event-memory-policy.js';
import {dailyEventFixtures} from '../apps/server/test/fixtures/daily-events.js';

const output=await mkdtemp(join(tmpdir(),'mote-daily-events-live-')),token=randomBytes(32).toString('hex'),data=await dailyEventFixtures();
const report:any={status:'running',personalDataUsed:false,physicalDevicesTested:false,realModel:true,ocr:'generated matching text fixture; not OCR quality validation',model:'gpt-6.1-sol',reasoningEffort:'high',calls:[],semanticQualityAccepted:false};
const config:Config={dataKey:undefined,dataDir:join(output,'vault'),token,tokenPath:join(output,'token'),host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:report.model,modelProvider:'codex',modelProtocol:'codex-app-server',modelReasoningEffort:'high',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentTimeoutMs:300000,diagnosticsEnabled:true,agentTraceEnabled:false,logLevel:'warn',codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME};
const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
try{
  report.code={};for(const path of ['apps/server/src/daily-event-memory-policy.ts','apps/server/src/material-organizers.ts','apps/server/src/memory-recipe-settings.ts','apps/server/src/evidence-reader.ts','packages/agent/src/instructions.ts'])report.code[path]=createHash('sha256').update(await readFile(path)).digest('hex');
  await writeFile(join(output,'manifest.json'),JSON.stringify({inputs:data.all.map(({imageBase64,...record})=>({...record,generatedImage:Boolean(imageBase64)})),ocr:Object.fromEntries(data.ocr),rubric:['ordinary article/product events retained','Oct 9 and Oct 10 in Asia/Shanghai separately recallable','Mira opinion never owner opinion','draft plan not complete','unpaid order distinct from paid order','paid but not shipped does not establish receipt/ownership','completed expense submission not reimbursement payment','exact quotes and current originals preserved']},null,2)+'\n',{mode:0o600});
  node=await buildApp(config,{backgroundWorker:true});
  const settings=node.lifecycle.settings();for(const key of ['working','consolidation','insights'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
  node.processing.configureImageDefault({endpoint:'http://127.0.0.1:9011/ocr'});
  node.processing.runtime.registry.get('image.http').process=async input=>({durationMs:0,segments:[{startMs:0,endMs:0,text:data.ocr.get(input.file.id)!}]});
  const query=node.agent.query.bind(node.agent);node.agent.query=async input=>{
    assert.ok(report.calls.length<14,'Generated live run exceeds its call bound');
    const call:any={phase:input.traceContext?.phase??'recap',startedAt:Date.now(),status:'running'};report.calls.push(call);await save();
    try{const result=await query(input);call.status='completed';call.tools=result.trace.map(entry=>({tool:entry.tool,arguments:entry.arguments}));if(call.phase==='recap')report.recap=result;return result;}
    catch(error){call.status='failed';throw error;}finally{call.durationMs=Date.now()-call.startedAt;await save();console.log(JSON.stringify({phase:call.phase,status:call.status,durationMs:call.durationMs}));}
  };
  const base=await node.app.listen({host:'127.0.0.1',port:0});
  const request=async(method:string,path:string,payload?:unknown)=>{const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});const result=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);return result;};
  await request('PUT','/api/memory-recipe-settings',{scope:'capture',recipes:[DAILY_EVENT_RECIPE]});
  report.binding=node.memoryStrategies.resolve(DAILY_EVENT_RECIPE).binding;
  for(const capture of data.all)await request('POST','/api/captures',capture);
  // Production background workers are used. Only settle timestamps are expedited.
  const deadline=Date.now()+12*60*1000;
  while(Date.now()<deadline){
    node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0 WHERE job_id IS NULL AND auto_authorized=1').run();
    const jobs=node.memoryPipeline.list();assert.ok(!jobs.some(job=>job.status==='failed'),JSON.stringify(jobs));
    const inputs=new Set(jobs.flatMap(job=>node!.memoryPipeline.get(job.id).workPackage?.inputs?.map(input=>input.inputKey)??[]));
    if(inputs.size===data.all.length&&jobs.length&&jobs.every(job=>job.status==='completed'))break;
    await delay(1000);
  }
  report.jobs=node.memoryPipeline.list().map(job=>node!.memoryPipeline.get(job.id));assert.ok(report.jobs.length&&report.jobs.every((job:any)=>job.status==='completed'),'All automatic jobs must finish');
  report.memories=report.jobs.flatMap((job:any)=>job.memoryIds.map((id:string)=>node!.memories.get(id)));
  assert.ok(report.memories.length>0,'Ordinary events must produce independently reviewed history');
  const covered=new Set<string>();
  for(const event of report.memories){assert.equal(event.admission.layer,'observation');assert.equal(event.reviewReceipt.decision,'independent');for(const span of event.evidence){const original:import('@mote/shared').CaptureRecord=node.memories.readEvidence([span.id])[0];assert.equal(original.ocrText.slice(span.offset,span.offset+span.length),span.quote);for(const id of node.memories.dependencyIds(span.id))covered.add(id);}}
  for(const capture of data.all){assert.ok(covered.has(capture.id),`Missing event proof for ${capture.windowTitle??capture.id}`);const original:import('@mote/shared').CaptureRecord=node.store.evidence([capture.id])[0];assert.ok(original);if(capture.metadata?.uiPage)assert.deepEqual(original.metadata?.uiPage,capture.metadata.uiPage);if(capture.imageBase64)assert.ok(node.store.image(capture.id));}
  report.coveredCaptureIds=data.all.map(capture=>capture.id);
  const reader=node.featureServices.evidenceReader.agent({diagnostics:node.diagnostics,currentGrantContext:()=>grant}),grant={};
  report.days={previous:await reader.memories!({layer:'observation',after:'2026-10-08T16:00:00Z',before:'2026-10-09T16:00:00Z'}),today:await reader.memories!({layer:'observation',after:'2026-10-09T16:00:00Z',before:'2026-10-10T16:00:00Z'})};
  assert.ok(report.days.previous.items.length&&report.days.today.items.length,'Both local days must be recallable');
  await node.agent.query({question:'请回顾我在 2026 年 10 月 10 日（Asia/Shanghai）采集记录中看到了什么、做了什么。按证据区分展示、浏览、计划、未支付、已支付、完成及未知结果。文章作者的观点不要算成我的观点；附原文引用，说明采集范围。',timeZone:'Asia/Shanghai'});
  report.status='passed';report.semanticQualityAwaitingIndependentInspection=true;
}catch(error){report.status='failed';report.failure=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{await node?.app.close();await save();console.log(JSON.stringify({status:report.status,report:join(output,'report.json')}));}
