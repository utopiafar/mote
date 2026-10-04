/** Generated reviewer regression, not extraction or end-to-end acceptance. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {createAgent,type QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {repositoryRoot} from '../apps/server/src/config.js';
import {Store,sha256} from '../apps/server/src/store.js';
import {SourceStore} from '../apps/server/src/sources.js';
import {MemoryStore,MemoryOutputValidationError} from '../apps/server/src/memory.js';
import {reviewMemory,memoryReviewReceipt} from '../apps/server/src/memory-review.js';
import {MemoryReviewCache} from '../apps/server/src/memory-review-cache.js';
import {personalMemoryReviewStrategyV2} from '../apps/server/src/personal-memory-review-policy.js';
import {codingMemoryReviewStrategyV2} from '../apps/server/src/coding-memory-review-policy.js';
import {personalReviewCases} from './fixtures/personal-review-cases.js';
import {codingReviewCases} from './fixtures/coding-review-cases.js';

assert.ok(process.env.MOTE_REVIEW_FIXTURE_OUTPUT,'Set a new MOTE_REVIEW_FIXTURE_OUTPUT outside Git');
const selection=process.env.MOTE_REVIEW_FIXTURE_STRATEGY??'personal-v2';
assert.ok(selection==='personal-v2'||selection==='coding-v2','Select a known generated regression explicitly');
const coding=selection==='coding-v2',cases=coding?codingReviewCases:personalReviewCases;
const strategy=coding?codingMemoryReviewStrategyV2:personalMemoryReviewStrategyV2;
const directory=resolve(process.env.MOTE_REVIEW_FIXTURE_OUTPUT),part=relative(repositoryRoot,directory);
assert.ok(part==='..'||part.startsWith('../'));await mkdir(directory,{mode:0o700});
const store=new Store(join(directory,'vault')),sources=new SourceStore(store),memories=new MemoryStore(store),cache=new MemoryReviewCache();
const agent=createAgent({provider:'codex',protocol:'codex-app-server',model:'gpt-6-sol',reasoningEffort:'max',agentTimeoutMs:300000,codex:{executable:process.env.MOTE_CODEX_BIN,home:process.env.MOTE_CODEX_HOME},reader:{search:async()=>[],timeline:async()=>({items:([]),nextCursor:null}),evidence:async({ids})=>store.evidence(ids),activity:async()=>({}),devices:async()=>[]}});
const report:Record<string,any>={startedAt:new Date().toISOString(),status:'running',semanticQualityAccepted:false,heldOut:false,personalDataUsed:false,generatedDraft:true,extractionTested:false,model:'gpt-6-sol',reasoningEffort:'max',maximumModelCalls:1,maximumDurationMs:300000,strategy,cases:[],calls:[],traces:[]};
report.fixtureSha256=sha256(await readFile(join(repositoryRoot,`scripts/fixtures/${coding?'coding':'personal'}-review-cases.ts`)));
report.codeHashes=Object.fromEntries(await Promise.all(['scripts/test-personal-review-live.ts',`apps/server/src/${coding?'coding':'personal'}-memory-review-policy.ts`,'apps/server/src/memory-review.ts','packages/agent/dist/task-context.js','packages/agent/dist/instructions.js'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
async function save(){await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
try{
  sources.register({id:'generated-review',name:`Generated ${coding?'coding':'personal'} review regression`,kind:'custom',deviceId:'generated',platform:'import'});
  const candidates=[],citations=[],ranges:{id:string;offset:number;length:number}[]=[];
  for(const c of cases){
    const row=await sources.upsert('generated-review',{externalId:c.id,revision:'1',observedAt:'2026-09-01T04:00:00Z',kind:'message',layer:'original',text:c.source,document:{contentRole:'authored'}});
    const record=store.evidence([row.id])[0];report.cases.push({...c,evidenceId:row.id});
    candidates.push({domain:coding?'coding':'personal',...(coding?{coding:{kind:'decision',scope:'session',validation:'unverified',applicability:'Only this supplied source; independently review the draft applicability'}}:{}),title:c.id,statement:c.draft+` [${row.id}]`,uncertainty:'Generated draft; evaluate against the original.',admission:{layer:'memory',attribution:'user',reason:'May help future tracking or personal context; this draft verdict requires independent review.',scope:'Only this supplied source'},evidenceIds:[row.id],evidence:[{id:row.id,quote:c.source}]});
    citations.push({id:row.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:c.source});ranges.push({id:row.id,offset:0,length:c.source.length});
  }
  const draft:QueryResult={answer:JSON.stringify({memories:candidates}),citations,trace:[],runId:randomUUID()};
  const input:QueryInput={question:'Review the supplied candidate draft against the supplied originals.',contextTime:'2026-09-01T04:00:00Z',timeZone:'Asia/Shanghai',language:'zh-CN',skill:'memory-strategy',responseMode:'memory-extraction',evidenceIds:ranges.map(r=>r.id),evidenceRanges:ranges,validateOutput:result=>{try{memories.extract(result,'gpt-6-sol',{requireAdmission:true,evidenceRanges:ranges,validateOnly:true});}catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}}};
  await save();
  const result=await reviewMemory(input,draft,async request=>{
    assert.equal(report.calls.length,0,'This regression permits one bounded reviewer run');
    const call:any={startedAt:new Date().toISOString(),status:'running'};report.calls.push(call);await save();console.log(JSON.stringify({stage:'review-start',cases:cases.length}));
    try{const value=await agent.query({...request,onUsage:usage=>{call.usage=usage;request.onUsage?.(usage);},onTrace:event=>{report.traces.push(event);request.onTrace?.(event);}});call.status='completed';call.runId=value.runId;return value;}
    catch(error){call.status='failed';throw error;}
    finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();}
  },{cache,snapshot:()=>sha256(JSON.stringify(store.evidence(ranges.map(r=>r.id)))),strategy});
  report.output=JSON.parse(result.answer);report.receipt=memoryReviewReceipt(result);report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();cache.clear();await agent.close();store.close();console.log(JSON.stringify({stage:'finished',status:report.status,report:join(directory,'report.json')}));}
