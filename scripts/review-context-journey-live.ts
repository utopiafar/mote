/** Re-review recorded outputs without rerunning extraction or answering. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join,relative,resolve} from 'node:path';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import {contextJudgmentQuestion} from './context-journey-judgment.js';

assert.ok(process.env.MOTE_JOURNEY_REVIEW_REPORT&&process.env.MOTE_JOURNEY_OUTPUT);
const path=resolve(process.env.MOTE_JOURNEY_REVIEW_REPORT),directory=resolve(process.env.MOTE_JOURNEY_OUTPUT);
for(const value of [path,directory]){const part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'));}
const bytes=await readFile(path),prior=JSON.parse(bytes.toString('utf8'));
assert.ok(prior.finishedAt&&prior.status==='failed'&&prior.model==='gpt-6-sol'&&prior.reasoningEffort==='max');
const selected=prior.cases.filter((c:any)=>c.status==='failed'&&c.job?.status==='completed'&&c.answer&&c.memories&&c.originals);
assert.ok(selected.length);await mkdir(directory,{mode:0o700});const vault=join(directory,'vault'),token=randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:100000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME};
const report:any={status:'running',startedAt:new Date().toISOString(),reviewOnlyFrom:path,sourceReportHash:sha256(bytes),personalDataUsed:prior.personalDataUsed,model:config.model,reasoningEffort:'max',extractionRepeated:false,answerRepeated:false,cases:[]};
report.reviewerHash=sha256(await readFile(new URL('./context-journey-judgment.ts',import.meta.url)));
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
async function save(){if(node)report.usage=node.featureServices.usageLedger.summary('2020-01-01','2100-01-01','UTC',{},'skill',1,200);await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
try{
 const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});assert.ok(catalog.items.find(m=>m.id===config.model)?.reasoningEfforts?.includes('max'));
 node=await buildApp(config);const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);await node.app.ready();
 for(const item of selected){
  const entry:any={id:item.id,status:'running'};report.cases.push(entry);await save();
  try{
   const originals=item.judgmentOriginals??item.originals;
   const known=new Set([...originals.map((o:any)=>o.id),...item.memories.map((m:any)=>m.id)]);
   assert.ok(item.answer.citations.every((c:any)=>known.has(c.id)),'Recorded review is missing a cited original');
   const question=contextJudgmentQuestion({fixture:item.fixture,originals,memories:item.memories,answer:item.answer,personalDataUsed:prior.personalDataUsed});entry.questionCharacters=question.length;entry.questionHash=sha256(question);
   console.log(JSON.stringify({stage:'semantic-judgment',case:item.id,characters:question.length}));
   const started=Date.now();entry.judgment=await node.featureServices.queryAgent({question},'query','evaluation');entry.durationMs=Date.now()-started;entry.verdict=JSON.parse(entry.judgment.answer);
   for(const field of ['pass','memoryPass','answerPass'])assert.equal(entry.verdict[field],true,entry.verdict.reason);entry.status='passed';
  }catch(error){entry.status='failed';entry.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
  await save();
 }
 report.status=report.cases.every((c:any)=>c.status==='passed')?'passed':'failed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();await node?.app.close();console.log(JSON.stringify({status:report.status,report:join(directory,'report.json')}));}
