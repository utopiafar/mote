/** Generated native audio -> confirmed speakers -> Memory -> Ask, using a closed acoustic run. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {cp,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {fileEvidenceSchema} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import {materialId} from '../apps/server/src/materials.js';
import {contextJudgmentQuestion} from './context-journey-judgment.js';

const {values}=parseArgs({options:{source:{type:'string'},output:{type:'string'},'retry-from':{type:'string'}}});
function external(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Run data must be outside Git');return value;}
assert.ok(values.source&&values.output,'Required: --source CLOSED_GENERATED_ACOUSTIC_RUN --output NEW_PRIVATE_DIRECTORY');
const source=external(values.source),directory=external(values.output);
for(const [a,b] of [[source,directory],[directory,source]]){const part=relative(a,b);assert.ok(part==='..'||part.startsWith('../'),'Source and output must be disjoint');}
async function empty(path:string){try{assert.equal((await stat(path)).size,0,`Source has live state: ${path}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
const sourceBytes=await readFile(join(source,'report.json')),seed=JSON.parse(sourceBytes.toString('utf8'));
const qualityBytes=await readFile(join(source,'quality.json')),quality=JSON.parse(qualityBytes.toString('utf8'));
assert.ok(seed.status==='passed'&&seed.finishedAt&&!seed.personalDataUsed&&seed.files.length===1&&seed.modelUsage.runs===0,'Source must be a generated native run without LLM calls');
assert.ok(quality.status==='passed'&&!quality.personalDataUsed&&!quality.humanAudioAccuracyVerified);assert.equal(quality.sourceReportSha256,sha256(sourceBytes));
assert.equal(quality.audioSha256,seed.files[0].sha256);
const sourceVault=join(source,'vault'),sourceDb=join(sourceVault,'mote.sqlite');await empty(join(sourceVault,'logs','central.lock'));await empty(sourceDb+'-wal');
const databaseHash=sha256(await readFile(sourceDb));assert.equal(databaseHash,quality.sourceDatabaseSha256);
const modules:string[]=[];if(seed.processorModule){const modulePath=resolve(seed.processorModule.path);assert.equal(sha256(await readFile(modulePath)),seed.processorModule.sha256,'Trusted processor module changed since acoustic processing');modules.push(modulePath);}
const fixtureBytes=await readFile(join(repositoryRoot,'scripts/fixtures/audio-memory.json'));
const fixture=z.object({speakerNamesByVoice:z.object({A:z.string(),B:z.string()}).strict(),question:z.string(),rubric:z.string()}).strict().parse(JSON.parse(fixtureBytes.toString('utf8')));
const retryDirectory=values['retry-from']?external(values['retry-from']):undefined;
let retrySeed:Record<string,any>|undefined,retryHash:string|undefined,retryReportHash:string|undefined;
if(retryDirectory){
 for(const [a,b] of [[retryDirectory,directory],[directory,retryDirectory]]){const part=relative(a,b);assert.ok(part==='..'||part.startsWith('../'),'Retry source and output must be disjoint');}
 const bytes=await readFile(join(retryDirectory,'report.json'));retryReportHash=sha256(bytes);retrySeed=JSON.parse(bytes.toString('utf8'));
 assert.ok(retrySeed?.status==='failed'&&retrySeed.finishedAt&&!retrySeed.personalDataUsed&&retrySeed.sourceUnchanged&&retrySeed.job?.status==='failed'&&retrySeed.job.memoryIds.length===0&&retrySeed.job.batches.every((b:any)=>b.status==='failed'&&b.errorCode==='provider_timeout'),'Retry source must be a closed generated extraction timeout');
 assert.equal(retrySeed.sourceReportHash,sha256(sourceBytes));assert.equal(retrySeed.sourceDatabaseHash,databaseHash);assert.equal(retrySeed.fixtureHash,sha256(fixtureBytes));assert.equal(retrySeed.model,'gpt-6-sol');assert.equal(retrySeed.reasoningEffort,'max');assert.equal(retrySeed.agentDeadlineMs,300000);
 await empty(join(retryDirectory,'vault/logs/central.lock'));await empty(join(retryDirectory,'vault/mote.sqlite-wal'));retryHash=sha256(await readFile(join(retryDirectory,'vault/mote.sqlite')));
}
const copyVault=retryDirectory?join(retryDirectory,'vault'):sourceVault,copyHash=retryHash??databaseHash;
await mkdir(directory,{mode:0o700});await cp(copyVault,join(directory,'vault'),{recursive:true,errorOnExist:true,force:false});
await empty(join(copyVault,'logs/central.lock'));await empty(join(copyVault,'mote.sqlite-wal'));assert.equal(sha256(await readFile(join(copyVault,'mote.sqlite'))),copyHash);assert.equal(sha256(await readFile(join(directory,'vault/mote.sqlite'))),copyHash);
const token=randomBytes(32).toString('hex');
function config(vault:string,modules:string[]=[]):Config{return {dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:300_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
 model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',
 diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1,fileProcessorModules:modules};}
const report:Record<string,any>={status:'running',startedAt:new Date().toISOString(),sourceRun:source,sourceReportHash:sha256(sourceBytes),sourceQualityHash:sha256(qualityBytes),sourceDatabaseHash:databaseHash,
 ...(retryDirectory?{retryFrom:retryDirectory,retrySourceDatabaseHash:retryHash,retrySourceReportHash:retryReportHash,previousUsage:retrySeed!.usageByVault,usageIncludesPriorAttempts:true}:{}),
 personalDataUsed:false,generatedOwnerConfirmation:true,humanSpeakerIdentityVerified:false,browserTested:false,physicalDevicesTested:false,acousticProcessingRepeated:false,memoriesRepublished:false,
 model:'gpt-6-sol',reasoningEffort:'max',agentDeadlineMs:300000,priority:['functionality','performance','cost'],semanticQualityAccepted:false,fixture,fixtureHash:sha256(fixtureBytes),stages:[],usageByVault:[],
 head:execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim()};
const paths=['scripts/test-audio-memory-live.ts','scripts/context-journey-judgment.ts','apps/server/src/files.ts','apps/server/src/file-reviews.ts','apps/server/src/file-speaker-attribution.ts','apps/server/src/material-organizers.ts','apps/server/src/materials.ts','apps/server/src/memory.ts','apps/server/src/memory-policy.ts','apps/server/src/memory-review.ts','apps/server/src/memory-pipeline.ts','apps/server/src/evidence-reader.ts','apps/server/src/evidence-exposure.ts','apps/server/src/app.ts','packages/shared/dist/files.js','packages/agent/dist/bridge.js','packages/agent/dist/instructions.js'];
report.codeHashes=Object.fromEntries(await Promise.all(paths.map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
let node:Awaited<ReturnType<typeof buildApp>>|undefined,currentVault='';
async function save(){if(node)report.activeUsage=node.featureServices.usageLedger.summary('2020-01-01','2100-01-01','UTC',{},'skill',1,200);await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
async function open(name:string,modules:string[]=[]){currentVault=name;node=await buildApp(config(join(directory,name),modules));const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);await node.app.ready();assert.equal(node.modelSettings.current().model,'gpt-6-sol');assert.equal(node.modelSettings.current().reasoningEffort,'max');}
async function close(){if(!node)return;report.usageByVault.push({vault:currentVault,usage:node.featureServices.usageLedger.summary('2020-01-01','2100-01-01','UTC',{},'skill',1,200)});const prior=node;node=undefined;delete report.activeUsage;await prior.app.close();}
async function request(method:'GET'|'POST'|'PUT',url:string,payload?:unknown){const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2'},...(payload?{payload}:{})});assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body}`);return response.json();}
async function stage<T>(name:string,work:()=>Promise<T>){const entry:Record<string,unknown>={name,status:'running',startedAt:new Date().toISOString()},start=Date.now();report.stages.push(entry);console.log(JSON.stringify({stage:name}));await save();try{const value=await work();entry.status='completed';return value;}catch(error){entry.status='failed';throw error;}finally{entry.durationMs=Date.now()-start;await save();}}
try{
 await save();const catalog=await codexModels(undefined,{executable:process.env.MOTE_CODEX_BIN,home:process.env.MOTE_CODEX_HOME});report.catalog=catalog.items.find(item=>item.id==='gpt-6-sol');assert.ok(report.catalog?.reasoningEfforts?.includes('max'));
 await open('vault',modules);
 const captureId=seed.files[0].captureId,detail=await request('GET','/api/files/'+captureId);assert.equal(detail.job.state,'succeeded');
 const view=await request('GET','/api/file-processing');await request('PUT','/api/file-processing',{revision:view.revision,settings:{...view.settings,enabled:false},policy:view.policy});
 const chunks=()=>node!.files.chunks(captureId,0,200).map(record=>({...record,fileEvidence:fileEvidenceSchema.parse(record.fileEvidence)}));
 const originalChunks=chunks();assert.ok(originalChunks.length&&originalChunks.length<200,'Control must fit completely; no truncated input');
 const artifactId=originalChunks[0].fileEvidence!.artifactId;assert.ok(originalChunks.every(record=>record.fileEvidence?.artifactId===artifactId));
 const mapping=quality.speakerSeparation.optimalOneToOneMapping;assert.ok(mapping.A&&mapping.B&&mapping.A!==mapping.B);
 const names=Object.fromEntries(Object.entries(fixture.speakerNamesByVoice).map(([voice,name])=>[mapping[voice],name]));
 await stage('confirm-generated-speakers',()=>request('POST',`/api/files/${captureId}/speakers`,{artifactId,names}));report.speakerConfirmation={names,method:'Known generated voice reference mapped by the unchanged acoustic scorer; simulated owner confirmation only'};
 const records=chunks();assert.deepEqual(records.map(r=>r.id),originalChunks.map(r=>r.id));assert.deepEqual(records.map(r=>r.ocrText),originalChunks.map(r=>r.ocrText));assert.ok(records.every(r=>r.fileEvidence?.speakerAttribution));
 const deviceId=records[0].deviceId;assert.ok(records.every(r=>r.deviceId===deviceId));report.captureId=captureId;report.fileEvidenceIds=records.map(r=>r.id);report.fileOriginals=node!.memories.readEvidence(report.fileEvidenceIds);
 await stage('publish-formal-audio-material',async()=>{
  let settled=false;for(let i=0;i<100;i++){if(await node!.materialOrganizer.tick(100)===0){settled=true;break;}}assert.ok(settled,'Material organizer did not settle');
  const provenance=node!.store.evidence([captureId])[0].provenance!;
  const material=node!.materials.get(materialId(provenance.sourceId,provenance.externalId));assert.ok(material);assert.equal(material.coverage.state,'complete');assert.ok(node!.materialMemoryWork.readyForMemory(material.ref));
  report.material=material;report.evidenceIds=node!.materials.evidenceIds(material.ref);report.originals=node!.memories.readEvidence(report.evidenceIds);
  const dialogue=report.originals.map((record:any)=>JSON.parse(record.ocrText)).filter((value:any)=>value.speaker);
  assert.equal(dialogue.length,records.length);assert.deepEqual(dialogue.map((value:any)=>value.speakerAttribution),records.map(record=>record.fileEvidence.speakerAttribution));
 });
 const job=await stage('memory-extraction-and-review',async()=>{
  if(retrySeed){assert.equal(report.material.ref,retrySeed.material.ref);assert.deepEqual(report.evidenceIds,retrySeed.evidenceIds);report.jobId=retrySeed.jobId;await request('POST',`/api/memory-jobs/${report.jobId}/retry`);}
  else{const created=await request('POST','/api/memory-jobs',{evidenceIds:report.evidenceIds,timeZone:'Asia/Shanghai'});report.jobId=created.id;}
  await save();const result=await node!.memoryPipeline.run(report.jobId);report.job=result;assert.equal(result.status,'completed',JSON.stringify(result.batches.map(b=>({index:b.index,status:b.status,error:b.errorCode}))));return result;
 });
 const memories=job.memoryIds.map(id=>node!.memories.get(id));report.memories=memories;
 assert.ok(memories.some(m=>m.admission?.layer==='memory'&&m.evidence?.some(e=>JSON.parse(node!.memories.readEvidence([e.id])[0]?.ocrText??'{}').speakerAttribution?.name===fixture.speakerNamesByVoice.A)),'No durable owner experience grounded in the recording');
 for(const memory of memories){assert.ok(memory.reviewRunId);for(const span of memory.evidence??[]){const original=node!.memories.readEvidence([span.id])[0];assert.ok(original);assert.equal(original.ocrText.slice(span.offset!,span.offset!+span.length!),span.quote);assert.ok(report.evidenceIds.includes(span.id));assert.ok(original.provenance?.uri?.startsWith(report.material.ref+'#'));}}
 report.answer=await stage('ask',()=>request('POST','/api/query',{question:fixture.question,deviceId,timeZone:'Asia/Shanghai'}));assert.equal(report.answer.modelSelection.model,'gpt-6-sol');
 const question=contextJudgmentQuestion({fixture:{...fixture,channel:'audio',events:[]},originals:report.originals,memories,answer:report.answer,personalDataUsed:false});
 await close();await open('review-vault');
 report.judgment=await stage('semantic-judgment',()=>node!.featureServices.queryAgent({question},'query','evaluation'));
 const verdict=z.object({pass:z.boolean(),memoryPass:z.boolean(),answerPass:z.boolean(),reason:z.string()}).strict().parse(JSON.parse(report.judgment.answer));report.verdict=verdict;report.semanticQualityAccepted=verdict.pass&&verdict.memoryPass&&verdict.answerPass;
 assert.ok(report.semanticQualityAccepted,verdict.reason);report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await close();report.finishedAt=new Date().toISOString();report.sourceUnchanged=sha256(await readFile(sourceDb))===databaseHash&&sha256(await readFile(join(source,'report.json')))===sha256(sourceBytes);assert.ok(report.sourceUnchanged);
 if(retryDirectory){await empty(join(retryDirectory,'vault/logs/central.lock'));await empty(join(retryDirectory,'vault/mote.sqlite-wal'));report.retrySourceUnchanged=sha256(await readFile(join(retryDirectory,'vault/mote.sqlite')))===retryHash&&sha256(await readFile(join(retryDirectory,'report.json')))===retryReportHash;assert.ok(report.retrySourceUnchanged);}
 await save();console.log(JSON.stringify({status:report.status,report:join(directory,'report.json')}));}
