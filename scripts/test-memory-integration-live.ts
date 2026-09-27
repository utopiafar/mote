/** Opt-in bounded integration on a private clone of a completed automatic replay. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {backup,DatabaseSync} from 'node:sqlite';
import {chmod,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import type {UsageReceipt} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';

function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private runs must stay outside Git');return value;}
assert.ok(process.env.MOTE_INTEGRATION_BASELINE&&process.env.MOTE_INTEGRATION_OUTPUT,'Set private baseline and a new output directory');
const baselineDirectory=outside(process.env.MOTE_INTEGRATION_BASELINE),directory=outside(process.env.MOTE_INTEGRATION_OUTPUT);
const baselineBytes=await readFile(join(baselineDirectory,'report.json')),baseline=JSON.parse(baselineBytes.toString());
assert.equal(baseline.status,'passed');assert.equal(baseline.model,'gpt-6-sol');assert.equal(baseline.reasoningEffort,'max');
const selected=baseline.memories.filter((m:any)=>m.admission?.layer==='memory'&&m.status!=='stale');
assert.ok(selected.length>0&&selected.length<=8,'Use a bounded completed sample, all its selected cards');
assert.ok(selected.every((m:any)=>m.domain==='personal'),'This run has one fixed personal domain and at most two outer model calls');
await mkdir(directory,{mode:0o700});
const vault=join(directory,'vault'),source=new DatabaseSync(join(baselineDirectory,'vault/mote.sqlite'),{readOnly:true});
try{
 assert.equal(source.prepare("SELECT count(*) n FROM memory_jobs WHERE json_extract(json,'$.status') NOT IN ('completed','failed','cancelled')").get()!.n,0);
 await cp(join(baselineDirectory,'vault'),vault,{recursive:true,errorOnExist:true,force:false,filter:path=>!['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','logs'].includes(basename(path))});await chmod(vault,0o700);await backup(source,join(vault,'mote.sqlite'));
}finally{source.close();}
const token=randomBytes(32).toString('hex'),config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:500_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:180000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1};
const report:Record<string,any>={status:'running',startedAt:new Date().toISOString(),semanticQualityAccepted:false,heldOut:false,personalDataUsed:true,baselineDirectory,baselineReportSha256:sha256(baselineBytes),model:'gpt-6-sol',reasoningEffort:'max',maximumOuterCalls:2,maximumDurationMs:400000,memoryIds:selected.map((m:any)=>m.id),browserTested:false,physicalDevicesTested:false,mediaProcessingTested:false,calls:[],head:execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim()};
report.codeHashes=Object.fromEntries(await Promise.all(['scripts/test-memory-integration-live.ts','apps/server/src/memory-integration.ts','apps/server/src/memory-integration-policy.ts','apps/server/src/memory-integration-settings.ts','apps/server/src/memory-lifecycle.ts','apps/server/src/memory-review.ts','apps/server/src/memory.ts','packages/agent/dist/skills.js','packages/agent/skills/memory-integration/SKILL.md'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
await writeFile(join(directory,'rubric-before-run.md'),`# Bounded integration evaluation, fixed before model execution\n\nInputs: all ${selected.length} current personal Memory cards from the completed baseline; no new source import, transcription, extraction or publication. This is an already inspected diagnostic sample, not held-out evaluation.\n\nExpected: inspect supplied cards and their original evidence. Existing cards alone do not prove new claims. A new synthesis requires a supported relationship/change/applicability missing from the existing cards; a generic summary, personality label, causal guess or duplicate is not a gain. Empty output is correct when there is no supported gain. No date, attribution or event-completion inventions. Proposed relationships must identify exact current target versions and original proof. Owner-confirmed facts and all baseline products must remain unchanged.\n\nExecution: one manual owner API request through the existing lifecycle/executor, local Codex App Server gpt-6-sol/max, at most two outer model calls, one attempt, 400 seconds overall. Restart and tick must not repeat completed work. Record elapsed time and provider-reported usage; unknown internal counts/prices remain unknown. Inspect any new card against originals after the run; passing transport/validation is not overall semantic acceptance.\n`,{mode:0o600});
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
async function save(){if(node&&report.operationId){const receipts=(node.store.db.prepare('SELECT json FROM model_usage').all() as {json:string}[]).map(r=>JSON.parse(r.json) as UsageReceipt).filter(r=>r.attribution?.operationId===report.operationId);report.usage={total:usageTotals(receipts),items:receipts};}await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
try{
 node=await buildApp(config,{backgroundWorker:false});await node.app.ready();
 const selectedModel=node.modelSettings.select('memory').settings;assert.equal(selectedModel.model,'gpt-6-sol');assert.equal(selectedModel.reasoningEffort,'max');assert.equal(selectedModel.protocol,'codex-app-server');
 const settings=node.lifecycle.settings();for(const name of ['extraction','consolidation','insights','working'] as const)settings[name].enabled=false;node.lifecycle.configure(settings);
 const prior=new Map((node.store.db.prepare('SELECT id,json FROM memories').all() as {id:string;json:string}[]).map(r=>[r.id,r.json]));
 const evidenceIds=[...new Set(selected.flatMap((m:any)=>m.evidenceIds))] as string[];
 report.originals=node.memories.readEvidence(evidenceIds).map(r=>({id:r.id,text:r.ocrText,textSha256:sha256(r.ocrText)}));
 const query=node.agent.query.bind(node.agent);node.agent.query=async input=>{
  assert.ok(report.calls.length<2,'Outer model call budget exceeded');assert.equal(input.skill,'memory-integration');
  const call:any={phase:input.traceContext?.phase,startedAt:new Date().toISOString(),status:'running'};report.calls.push(call);await save();console.log(JSON.stringify({stage:'model-start',phase:call.phase}));
  try{const result=await query(input);call.status='completed';call.result=result;return result;}catch(error){call.status='failed';throw error;}finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();}
 };
 await save();const response=await node.app.inject({method:'POST',url:'/api/memory-integrations',headers:{authorization:'Bearer '+token},payload:{recipe:{id:'mote.memory-integration',version:'1'},memoryIds:report.memoryIds}});assert.equal(response.statusCode,202,response.body);
 report.operationId=response.json().operationId;report.windowId=response.json().id;await save();
 const timer=setTimeout(()=>node?.lifecycle.cancel('consolidation',report.windowId),400000);timer.unref();
 try{await node.lifecycle.tick();}finally{clearTimeout(timer);}
 report.lifecycle=node.lifecycle.view().extensions.find(e=>e.id==='consolidation');assert.equal(report.lifecycle.active,undefined,JSON.stringify({status:report.lifecycle.status,error:report.lifecycle.error}));
 report.products=(node.store.db.prepare('SELECT id,json FROM memories').all() as {id:string;json:string}[]).filter(r=>!prior.has(r.id)).map(r=>JSON.parse(r.json));
 for(const [id,json] of prior)assert.equal(node.store.db.prepare('SELECT json FROM memories WHERE id=?').get(id)?.json,json);
 for(const original of report.originals)assert.equal(sha256(node.memories.readEvidence([original.id])[0].ocrText),original.textSha256);
 report.baselineProductsUnchanged=true;report.originalsUnchanged=true;await save();await node.app.close();node=undefined;
 node=await buildApp(config,{backgroundWorker:false});await node.app.ready();node.agent.query=async()=>{throw Error('Unexpected paid replay');};await node.lifecycle.tick();assert.equal(node.lifecycle.view().extensions.find(e=>e.id==='consolidation')!.active,undefined);report.restartNoReplay=true;
 assert.equal(sha256(await readFile(join(baselineDirectory,'report.json'))),report.baselineReportSha256);report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();await node?.app.close();console.log(JSON.stringify({stage:'finished',status:report.status,report:join(directory,'report.json')}));}
