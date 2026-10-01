/** Opt-in real Feishu + configured model validation. Private data never enters
 * source control or the console. Fixture checks live in recordings.test.ts. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildApp} from '../apps/server/src/app.js';
import {createFeishuRecordings} from '../apps/server/src/connectors/lark-recordings.js';
import type {Config} from '../apps/server/src/config.js';
import type {RecordingProvider} from '../apps/server/src/connectors/recordings.js';
import type {ModelSettings} from '@mote/shared/models';
import {createModelAgent} from '../apps/server/src/model-agent.js';

if(process.env.MOTE_RECORDING_LIVE_CONSENT!=='1')throw Error('Set MOTE_RECORDING_LIVE_CONSENT=1 only with explicit consent to read vendor recordings and send selected transcripts to the configured model.');
const directory=resolve(process.env.MOTE_RECORDING_LIVE_DIR??'/tmp/mote-recording-live-private');
await mkdir(directory,{recursive:true,mode:0o700});
const modelFile=process.env.MOTE_RECORDING_LIVE_MODEL_SETTINGS;if(!modelFile)throw Error('Set MOTE_RECORDING_LIVE_MODEL_SETTINGS to the authorized existing model settings file.');
const modelState=JSON.parse(await readFile(modelFile,'utf8')),modelId=modelState.defaults?.memory??'default';
const settings:ModelSettings=modelId==='default'?modelState.settings:modelState.profiles?.find((p:any)=>p.id===modelId)?.settings;
if(!settings)throw Error('Memory model is not configured.');
const actual=createFeishuRecordings(join(directory,'connectors')),signal=new AbortController().signal;
const account=await actual.account(signal),range={start:process.env.MOTE_RECORDING_LIVE_START??'2026-09-01T00:00:00Z',end:process.env.MOTE_RECORDING_LIVE_END??new Date().toISOString()};
const discovered=await actual.discover(account,range,signal);if(!discovered.ids.length)throw Error('No accessible recording in the validation window.');
// Deliberately validate one real recording; pagination completeness has a
// separate generated-fixture test. This is not a full personal history import.
const chosen=discovered.ids[0]!,metadata=await actual.metadata(account,chosen,signal);
const provider:RecordingProvider={...actual,discover:async(bound,window,abort)=>{
 const page=await actual.discover(bound,window,abort);return {ids:page.ids.includes(chosen)?[chosen]:[]};
}};
const config:Config={dataKey:undefined,dataDir:join(directory,'vault'),token:'local-live-validation-'+createHash('sha256').update(directory).digest('hex'),tokenPath:'private-validation',host:'127.0.0.1',port:0,maxStorageBytes:1024*1024*1024,maxExportBytes:512*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],modelProvider:settings.provider,modelProtocol:settings.protocol,model:settings.model,modelBaseUrl:settings.baseUrl,apiKey:settings.apiKey,modelReasoningEffort:settings.reasoningEffort,modelMaxTokens:settings.maxTokens,modelRequestTimeoutMs:settings.modelRequestTimeoutMs,agentTimeoutMs:settings.agentTimeoutMs,modelHeaders:settings.headers,modelExtraBody:settings.extraBody,allowUnauthenticatedLocal:settings.allowUnauthenticatedLocal,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true};
let calls=0;
const node=await buildApp(config,{backgroundWorker:false,connectorTesting:{recordings:[provider]},createModelAgent:async(model,reader)=>{
 const runtime=await createModelAgent(model,reader);return {configured:runtime.configured,close:()=>runtime.close(),query:async input=>{calls++;console.log(JSON.stringify({stage:'model',phase:input.traceContext?.phase??input.skill,call:calls}));return runtime.query(input);}};
}});
const report:{[key:string]:unknown}={sampleCount:1,personalDataUsed:true,physicalDeviceTested:false,model:settings.model,modelProtocol:settings.protocol,discoveryHasMore:!!discovered.next,startedAt:new Date().toISOString()};
try{
 await node.app.ready();const headers={authorization:'Bearer '+config.token};
 const request=async(method:'GET'|'POST'|'PUT',suffix='',payload?:unknown)=>{const r=await node.app.inject({method,url:'/api/connectors/feishu-recordings'+suffix,headers,...(payload?{payload}:{})});assert.equal(r.statusCode,200);return r.json();};
 await request('POST','/connect');await request('PUT','/selection',{enabled:true,...range,autoSync:false,backupAudio:true});
 for(let n=0;n<100;n++){const rows=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'recording.feishu.%' AND state IN ('waiting','running') AND available_at<=? LIMIT 100").all(Date.now()) as {id:string}[];if(!rows.length)break;await node.executor.drain(rows.map(r=>r.id));}
 const status=await request('GET');report.sync=status.counts;report.steps=status.steps;
 assert.equal(status.counts.transcripts,1,'Transcript archive did not complete');assert.equal(status.counts.audio,1,'Audio backup did not complete');assert.equal(status.counts.failed,0);
 const head=node.sources.getItem(status.sourceId,metadata.id)!;report.captureId=head.captureId;
 const audio=node.archivedFiles.listForCapture(head.captureId)[0];assert.ok(audio);const bytes=node.archivedFiles.read(audio.id);assert.equal(createHash('sha256').update(bytes).digest('hex'),audio.hash);report.audio={bytes:bytes.length,mimeType:audio.mimeType,checksumVerified:true};
 await writeFile(join(directory,'validation-audio.bin'),bytes,{mode:0o600});
 await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);
 const materials=node.materials.list({sourceId:status.sourceId}).items.map(m=>node.materials.get(m.ref)!);assert.equal(materials.length,1);assert.equal(materials[0].coverage.state,'complete');report.material={ref:materials[0].ref,coverage:materials[0].coverage,blocks:materials[0].blockCount};
 console.log(JSON.stringify({stage:'archive',transcripts:1,audioBytes:bytes.length,materialBlocks:materials[0].blockCount}));
 node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);await Promise.all(node.memoryPipeline.list().filter(j=>j.status!=='completed').map(j=>['failed','cancelled'].includes(j.status)?node.memoryPipeline.retry(j.id):node.memoryPipeline.run(j.id)));
 const jobs=node.memoryPipeline.list().map(j=>node.memoryPipeline.get(j.id));report.memory=jobs;assert.ok(jobs.length>0,'Automatic Memory was not scheduled');assert.ok(jobs.every(j=>j.status==='completed'),'Memory pipeline did not complete');
 report.memoryCount=jobs.reduce((n,j)=>n+j.memoryIds.length,0);assert.ok(Number(report.memoryCount)>0,'No evidence-supported Memory was produced');
 const memoryIds=[...new Set(jobs.flatMap(j=>j.memoryIds))],cards=memoryIds.map(id=>node.memories.get(id));
 assert.ok(cards.every(Boolean),'A completed Memory reference is unavailable');
 await writeFile(join(directory,'memory-cards.json'),JSON.stringify({captureId:head.captureId,memories:cards},null,2),{mode:0o600});
 const before=calls;await request('POST','/sync');for(let n=0;n<30;n++){const rows=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'recording.feishu.%' AND state IN ('waiting','running') LIMIT 100").all() as {id:string}[];if(!rows.length)break;await node.executor.drain(rows.map(r=>r.id));}
 await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);await new Promise(r=>setImmediate(r));assert.equal(calls,before,'Duplicate sync replayed model work');
 report.duplicateModelReplay=false;report.completedAt=new Date().toISOString();report.status='passed';console.log(JSON.stringify({stage:'passed',memoryCount:report.memoryCount,modelCalls:calls,privateDirectory:directory}));
}catch(error){report.status='failed';report.error=error instanceof Error?error.name:'unknown';report.errorDetails=error instanceof Error?{message:error.message,stack:error.stack}:{};console.error(JSON.stringify({stage:'failed',error:report.error,privateDirectory:directory}));process.exitCode=1;}
finally{await writeFile(join(directory,'validation-report.json'),JSON.stringify(report,null,2),{mode:0o600});await node.app.close();}
