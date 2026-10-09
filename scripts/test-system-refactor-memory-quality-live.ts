/** Opt-in generated owner/third-party quality journey through production HTTP + Codex. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';

const output=await mkdtemp(join(tmpdir(),'mote-refactor-memory-quality-')),directory=join(output,'vault'),token=randomBytes(32).toString('hex');
const report:any={status:'running',personalDataUsed:false,physicalDevicesTested:false,model:'gpt-6.1-sol',reasoningEffort:'high',http:true,productionBackgroundWorker:true,head:process.env.MOTE_TEST_RELEASE_COMMIT??execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim(),calls:[]};
const cfg:Config={dataKey:undefined,dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:report.model,modelProvider:'codex',modelProtocol:'codex-app-server',modelReasoningEffort:'high',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentConcurrency:2,llmConcurrency:2,memoryConcurrency:2,agentTimeoutMs:300000,diagnosticsEnabled:true,agentTraceEnabled:false,logLevel:'warn',codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME};
const inputs=[
  {sourceId:'generated-owner',ownerRelation:'owner',externalId:'personal-experience',text:'Over the past month I felt exhausted and anxious after our large family gatherings, because several relatives interrupted me and I struggled to say what I needed. I tried meeting my sister alone for a quiet walk on three Sundays. Each time I could explain my concerns and came home feeling understood and calmer. I have learned that one-to-one conversations in a quiet place suit me better than a crowded family discussion when I need emotional support. I want to remember this personal preference and use quiet walks with my sister again. I plan to try talking to my father this way next Tuesday; that conversation has not happened yet.'},
  {sourceId:'generated-third-party',ownerRelation:'third_party',externalId:'mira-interview',text:'Interviewee Mira says she prefers morning runs and plans to attend a marathon next month. This is only Mira’s statement. The archive owner has not expressed a running preference, has not registered for a marathon, and has not completed Mira’s planned event.'},
] as const;
const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
try{
  await writeFile(join(output,'manifest.json'),JSON.stringify({inputs,rubric:['at least one original-backed owner personal experience card','quiet one-to-one conversation preference remains scoped to seeking family emotional support','completed sister walks remain distinct from planned father conversation','Mira preference is never owner preference','all independent reviews and original quotation offsets valid']},null,2)+'\n',{mode:0o600});
  node=await buildApp(cfg,{backgroundWorker:true});
  const query=node.agent.query.bind(node.agent);
  node.agent.query=async input=>{
    assert.ok(report.calls.length<10,'Bounded quality run exceeded ten fragments');
    const call:any={phase:input.traceContext?.phase,jobId:input.traceContext?.jobId,startedAt:Date.now(),status:'running'};report.calls.push(call);await save();
    try{const result=await query(input);call.status='completed';call.tools=result.trace.map(entry=>entry.tool);return result;}
    catch(error){call.status='failed';throw error;}
    finally{call.durationMs=Date.now()-call.startedAt;await save();console.log(JSON.stringify({phase:call.phase,status:call.status,durationMs:call.durationMs}));}
  };
  const settings=node.lifecycle.settings();for(const key of ['working','consolidation','insights'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
  const base=await node.app.listen({host:'127.0.0.1',port:0});
  const request=async(method:string,path:string,payload?:unknown)=>{const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2',...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});const value=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status}`);return value;};
  for(const input of inputs){
    await request('POST','/api/sources',{id:input.sourceId,name:input.sourceId,kind:'custom',deviceId:input.sourceId,platform:'import',retention:'archive',ownerRelation:input.ownerRelation});
    const payload={externalId:input.externalId,revision:'1',observedAt:'2026-10-01T08:00:00Z',kind:'message',layer:'original',text:input.text,document:{contentRole:input.ownerRelation==='owner'?'authored':'reference',recordedAt:'2026-10-01T08:00:00Z',timeBasis:'recorded'}};
    const ack=await request('PUT','/api/sources/'+input.sourceId+'/items',payload),duplicate=await request('PUT','/api/sources/'+input.sourceId+'/items',payload);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.id,ack.id);
  }
  const deadline=Date.now()+12*60*1000;
  while(Date.now()<deadline){const jobs=node.memoryPipeline.list(),members=new Set(jobs.flatMap(job=>node!.memoryPipeline.get(job.id)?.workPackage?.inputs?.map(input=>input.inputKey)??[]));assert.ok(!jobs.some(job=>job.status==='failed'),'Automatic Memory failed');if(members.size===inputs.length&&jobs.every(job=>job.status==='completed'))break;await delay(500);}
  report.jobs=node.memoryPipeline.list().map(job=>node!.memoryPipeline.get(job.id));assert.ok(report.jobs.length);assert.ok(report.jobs.every((job:any)=>job.status==='completed'));
  report.memories=report.jobs.flatMap((job:any)=>job.memoryIds.map((id:string)=>node!.memories.get(id)));
  assert.ok(report.memories.length>0,'Positive owner experience must produce reviewed Memory');
  for(const memory of report.memories){assert.equal(memory.status,'published');assert.ok(memory.reviewReceipt);for(const span of memory.evidence??[]){const original:any=node.memories.readEvidence([span.id])[0];assert.ok(original);assert.equal(original.ocrText.slice(span.offset,span.offset+span.length),span.quote);}}
  report.qualityAwaitingIndependentInspection=true;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{await node?.app.close();await save();console.log(JSON.stringify({status:report.status,report:join(output,'report.json')}));}
