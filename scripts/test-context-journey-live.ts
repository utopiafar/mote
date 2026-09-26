/** Opt-in production-path live evaluation. Generated data; never the user's active vault. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import {contextJourneyCases,type ContextJourneyCase} from './fixtures/context-journey.js';
import {contextJudgmentQuestion} from './context-journey-judgment.js';

const externalManifest=process.env.MOTE_JOURNEY_MANIFEST;
const caseSchema=z.object({id:z.string().regex(/^[a-z0-9-]+$/),channel:z.enum(['note','coding']),events:z.array(z.object({at:z.string().datetime({offset:true}),text:z.string().min(1).max(100000),role:z.enum(['user','tool_result']).optional()}).strict()).min(1).max(30),question:z.string().min(1).max(8000),rubric:z.string().min(1).max(8000),requiredMemoryEvents:z.array(z.number().int().nonnegative()).optional(),requiresMemory:z.boolean().optional(),observationOnly:z.boolean().optional(),incremental:z.boolean().optional()}).strict();
const supplied=externalManifest?z.object({personalDataUsed:z.boolean(),cases:z.array(caseSchema).min(1).max(30)}).strict().parse(JSON.parse(await readFile(externalManifest,'utf8'))):{personalDataUsed:false,cases:contextJourneyCases};
const selected=(process.env.MOTE_JOURNEY_CASES??supplied.cases[0].id).split(',');
assert.ok(selected.length&&new Set(selected).size===selected.length,'Choose unique fixture IDs');
for(const id of selected)assert.ok(supplied.cases.some(c=>c.id===id),`Unknown fixture: ${id}`);
let directory:string;
let previous:Record<string,any>|undefined;
if(process.env.MOTE_JOURNEY_OUTPUT){
  directory=resolve(process.env.MOTE_JOURNEY_OUTPUT);
  const path=relative(repositoryRoot,directory);
  assert.ok(path==='..'||path.startsWith('../'),'Reports must be outside source control');
  if(process.env.MOTE_JOURNEY_RESUME==='1'){
    previous=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
    assert.ok(previous?.status==='failed'&&previous.model==='gpt-6-sol'&&previous.reasoningEffort==='max'&&previous.personalDataUsed===false,'Only a failed generated run with the same model can resume');
    assert.equal(selected.length,1);assert.equal(selected[0],'incremental-correction');
    await writeFile(join(directory,`report.previous-${randomUUID()}.json`),JSON.stringify(previous,null,2)+'\n',{mode:0o600,flag:'wx'});
  }else await mkdir(directory,{mode:0o700}); // Existing runs must never be overwritten.
}else directory=await mkdtemp(join(tmpdir(),'mote-context-journey-'));
const token=randomBytes(32).toString('hex'),vault=join(directory,'vault');
const importRun=process.env.MOTE_JOURNEY_IMPORT_RUN;
let imported:Record<string,unknown>|undefined;
if(importRun){
  assert.ok(!previous&&supplied.personalDataUsed&&externalManifest,'Import replay requires a new private case run');
  const source=resolve(importRun),part=relative(repositoryRoot,source);assert.ok(part==='..'||part.startsWith('../'));
  const bytes=await readFile(join(source,'report.json')),prior=JSON.parse(bytes.toString('utf8'));
  assert.ok(prior.status==='passed'&&prior.personalDataUsed&&prior.scriptSha256&&prior.jobId&&prior.records,'Source must be a completed private import journey');
  const hash=sha256(await readFile(join(source,'vault','mote.sqlite')));
  await cp(join(source,'vault'),vault,{recursive:true,errorOnExist:true,force:false});
  assert.equal(sha256(await readFile(join(source,'vault','mote.sqlite'))),hash,'Source import changed during copy');
  assert.equal(sha256(await readFile(join(vault,'mote.sqlite'))),hash);
  imported={sourceRun:source,sourceReportHash:sha256(bytes),sourceDatabaseHash:hash};
}
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,
  maxStorageBytes:200_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',
  diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,
  codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1};
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const report:Record<string,unknown>={startedAt:new Date().toISOString(),status:'running',model:config.model,reasoningEffort:'max',
  priority:['functionality','performance','cost'],personalDataUsed:supplied.personalDataUsed,browserTested:false,physicalDevicesTested:false,
  mediaProcessingTested:false,agentDeadlineMs:300000,selected,
  head:execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim(),
  worktreeDiff:execFileSync('git',['diff','--stat'],{cwd:repositoryRoot,encoding:'utf8'}),cases:[]};
if(imported)report.imported=imported;
report.runnerHashes=Object.fromEntries(await Promise.all(['scripts/test-context-journey-live.ts','scripts/context-journey-judgment.ts','scripts/fixtures/context-journey.ts'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
const cases=report.cases as Record<string,unknown>[];
async function save(){
  if(node)report.usage=node.featureServices.usageLedger.summary('2020-01-01','2100-01-01','UTC',{},'skill',1,200);
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
function progress(stage:string,extra:Record<string,unknown>={}){console.log(JSON.stringify({stage,...extra}));}
async function request(method:'GET'|'POST'|'PUT',url:string,payload?:Record<string,unknown>){
  const response=await node!.app.inject({method,url,headers:{authorization:`Bearer ${token}`,'x-mote-ingress-version':'2'},...(payload?{payload}:{})});
  assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body}`);
  return response.json();
}
async function runCase(fixture:ContextJourneyCase){
  const started=Date.now();let deviceId='generated-'+fixture.id,queryScope:Record<string,string>={};
  const result:Record<string,unknown>={id:fixture.id,fixture,status:'running',stages:[]};cases.push(result);await save();
  async function stage<T>(name:string,operation:()=>Promise<T>):Promise<T>{
    const entry:Record<string,unknown>={name,status:'running',startedAt:new Date().toISOString()};
    (result.stages as unknown[]).push(entry);progress(name,{case:fixture.id});await save();const at=Date.now();
    try{const value=await operation();entry.status='completed';return value;}
    catch(error){entry.status='failed';entry.error=error instanceof Error?error.message:String(error);throw error;}
    finally{entry.durationMs=Date.now()-at;await save();}
  }
  try{
    const ids:string[]=[],memoryIds=new Set<string>();
    if(fixture.incremental)assert.ok(!supplied.personalDataUsed&&fixture.channel==='note'&&fixture.events.length>=2,'Incremental publication is generated-fixture only');
    async function extract(name:string,evidenceIds:string[]){
      return stage(name,async()=>{
        const created=await request('POST','/api/memory-jobs',{evidenceIds,timeZone:'Asia/Shanghai'});result.jobId=created.id;await save();
        const completed=await node!.memoryPipeline.run(created.id),jobs=(result.jobs??=[]) as unknown[];
        jobs.push(completed);assert.equal(completed.status,'completed',JSON.stringify(completed.batches));
        for(const id of completed.memoryIds)memoryIds.add(id);return completed;
      });
    }
    async function publish(selected:Iterable<string>){for(const id of selected){const memory=node!.memories.get(id);if(memory.status==='proposed')await request('POST',`/api/memories/${id}/publish`,{version:memory.version});}}
    const prior=previous?.cases.find((item:{id:string})=>item.id===fixture.id);
    if(prior){
      assert.ok(fixture.incremental&&prior.job?.status==='completed'&&prior.memories?.length&&prior.evidenceIds?.length===fixture.events.length,'Prior extraction must be complete before resuming consolidation');
      assert.deepEqual(prior.fixture.events,fixture.events);ids.push(...prior.evidenceIds);
      for(const memory of prior.memories)memoryIds.add(memory.id);
      result.evidenceIds=ids;result.beforeUpdate=prior.beforeUpdate;result.memories=prior.memories;result.resumedFrom=previous!.startedAt;
    }else if(imported)await stage('select-imported-materials',async()=>{
      assert.ok(fixture.channel==='note'&&!fixture.incremental,'Import selection uses complete authored notes');
      const payloads=node!.store.db.prepare('SELECT hash,text FROM material_block_payloads').all().flatMap(row=>{
        try{const value=JSON.parse(String(row.text));return typeof value.text==='string'?[{hash:String(row.hash),text:value.text as string}]:[];}catch{return [];}
      });
      const selectedMaterials=[];
      for(const event of fixture.events){
        const matches=payloads.filter(p=>p.text.trim()===event.text.trim());assert.equal(matches.length,1,'Original text must match one imported payload exactly, apart from outer whitespace');
        const heads=node!.store.db.prepare('SELECT h.id,h.revision,h.device_id,h.first_at,h.last_at FROM material_blocks b JOIN material_heads h ON h.id=b.material_id AND h.revision=b.revision WHERE b.payload_hash=? AND h.retired=0').all(matches[0].hash);
        assert.equal(heads.length,1);const head=heads[0],material=node!.materials.get(String(head.id));assert.ok(material);selectedMaterials.push(head);
        const anchors=node!.materials.evidenceIds(material.ref);assert.equal(anchors.length,1,'This fixture expects one full-text Material anchor per original');
        assert.ok(node!.materialMemoryWork.readyForMemory(material.ref),'Imported Material dependencies must be ready');ids.push(...anchors);
      }
      const devices=new Set(selectedMaterials.map(m=>String(m.device_id)));assert.equal(devices.size,1);deviceId=[...devices][0];
      queryScope={after:new Date(Math.min(...selectedMaterials.map(m=>Date.parse(String(m.first_at))))).toISOString(),before:new Date(Math.max(...selectedMaterials.map(m=>Date.parse(String(m.last_at))))+1).toISOString()};
      result.materials=selectedMaterials;result.queryScope={...queryScope,deviceId};result.evidenceIds=ids;
    });else await stage('ingress',async()=>{
      if(fixture.channel==='note'){
        for(const [index,event] of fixture.events.entries()){
          const payload={id:randomUUID(),deviceId,deviceName:'Generated journey',platform:'import',capturedAt:event.at,text:event.text};
          const ack=await request('POST','/api/notes',payload);assert.equal(ack.receipt.state,'received');ids.push(ack.id);
          const duplicate=await request('POST','/api/notes',payload);assert.equal(duplicate.id,ack.id);assert.equal(duplicate.duplicate,true);
          if(fixture.incremental&&index===fixture.events.length-2){
            const before=await extract('memory-before-update',ids);assert.ok(before.memoryIds.length,'Initial extraction produced no baseline');
            await stage('publish-initial-generated-memories',()=>publish(memoryIds));result.beforeUpdate=[...memoryIds].map(id=>node!.memories.get(id));await save();
          }
        }
      }else{
        await request('POST','/api/sources',{id:deviceId,name:'Generated agent conversation',kind:'coding-agent',deviceId,platform:'import'});
        const items=fixture.events.map((event,index)=>({externalId:String(index),revision:'1',observedAt:event.at,kind:'message',layer:'snapshot',text:event.text,
          document:{contentRole:'transcript',recordedAt:event.at,coding:{version:1,provider:'kimi',sessionId:fixture.id,projectKey:sha256('kimi:'+fixture.id),
            projectIdentity:'session',eventId:String(index),role:event.role??'user',part:0,parts:1}}}));
        const batch=await request('POST',`/api/sources/${deviceId}/items/batch`,{items});
        assert.equal(batch.receipts.length,items.length);assert.ok(batch.receipts.every((ack:{receipt:{state:string}})=>ack.receipt.state==='received'));
        await node!.sourcePipelines.tick();
        const material=node!.materials.list({sourceId:deviceId}).items.find(item=>item.origin.sessionId===fixture.id);
        assert.ok(material,'Source events did not produce their logical material');
        assert.equal(material.coverage.state,'complete');result.material=material;
        ids.push(...node!.materials.evidenceIds(material.ref));
      }
      assert.ok(ids.length);result.evidenceIds=ids;
    });
    const originals=node!.memories.readEvidence(ids);result.originals=originals;
    const job=prior?.job??await extract('memory-extraction',fixture.incremental?ids.slice(-1):ids);result.job=job;
    if(fixture.incremental)await stage('publish-generated-update',()=>publish(job.memoryIds));
    const newMemoryIds=new Set<string>(job.memoryIds);
    if(fixture.incremental)await stage('consolidate-new-and-existing-memories',async()=>{
      if(prior&&process.env.MOTE_JOURNEY_REPLAY_CONSOLIDATION==='1'){
        const state=JSON.parse(String(node!.store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='consolidation'").get()!.json));
        assert.ok(!state.active,'Cannot replay a running consolidation window');result.replayedGeneratedConsolidationState=state;
        node!.store.db.prepare("UPDATE memory_lifecycle_state SET json=? WHERE id='consolidation'").run(JSON.stringify({...state,cursor:0,lastSuccess:0,failures:0}));
      }
      const settings=node!.lifecycle.settings();settings.consolidation.enabled=true;settings.consolidation.minChanges=1;settings.consolidation.maxItems=50;
      node!.lifecycle.configure(settings);
      try{await node!.lifecycle.tick();}finally{settings.consolidation.enabled=false;node!.lifecycle.configure(settings);}
      result.consolidation=node!.lifecycle.view();const state=node!.lifecycle.view().extensions.find(extension=>extension.id==='consolidation');
      assert.ok(state?.lastRun&&!state.error,JSON.stringify(state));
      const consolidated=node!.memories.list({deviceId,tier:'consolidated',includeHistory:true,limit:200});
      for(const memory of consolidated){memoryIds.add(memory.id);newMemoryIds.add(memory.id);}
      assert.ok(consolidated.length,'Consolidation did not produce an update proposal');
      await publish(consolidated.map(memory=>memory.id));
    });
    const memories=[...memoryIds].map(id=>node!.memories.get(id));result.memories=memories;
    if(fixture.incremental)assert.ok(memories.some(memory=>memory.supersededBy&&newMemoryIds.has(memory.supersededBy)),'New evidence did not supersede the earlier published memory');
    for(const memory of memories){
      assert.ok(memory.reviewRunId,'Memory bypassed independent production review');
      for(const span of memory.evidence??[]){
        const original=node!.memories.readEvidence([span.id])[0];assert.ok(original);
        assert.equal(original.ocrText.slice(span.offset!,span.offset!+span.length!),span.quote,'Evidence quote is not exact');
      }
    }
    if(fixture.observationOnly)assert.ok(memories.every(memory=>memory.admission?.layer==='observation'),'Task/third-party content became long-term memory');
    if(fixture.requiresMemory)assert.ok(memories.some(memory=>memory.admission?.layer==='memory'),'Explicit owner experience was lost');
    for(const index of fixture.requiredMemoryEvents??[]){
      assert.equal(fixture.channel,'note');
      assert.ok(memories.some(memory=>memory.admission?.layer==='memory'&&memory.evidenceIds.includes(ids[index])&&(!fixture.incremental||!memory.supersededBy)),`Required dated owner event ${index} was lost`);
    }
    const answer=await stage('question',()=>request('POST','/api/query',{question:fixture.question,deviceId,...queryScope,timeZone:'Asia/Shanghai'}));
    result.answer=answer;assert.equal(answer.modelSelection.model,config.model);
    const judgmentOriginals=imported?[...new Map([...originals,...node!.memories.readEvidence(answer.citations.map((c:{id:string})=>c.id))].map(o=>[o.id,o])).values()]:originals;
    result.judgmentOriginals=judgmentOriginals;
    const judgment=await stage('semantic-judgment',()=>node!.featureServices.queryAgent({
      question:contextJudgmentQuestion({fixture,originals:judgmentOriginals,memories,answer,personalDataUsed:supplied.personalDataUsed}),
    },'query','evaluation'));
    result.judgment=judgment;
    const verdict=JSON.parse(judgment.answer);result.verdict=verdict;
    assert.equal(verdict.pass,true,verdict.reason);assert.equal(verdict.memoryPass,true,verdict.reason);assert.equal(verdict.answerPass,true,verdict.reason);
    result.status='passed';
  }catch(error){result.status='failed';result.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
  finally{result.durationMs=Date.now()-started;await save();progress('case-finished',{case:fixture.id,status:result.status,durationMs:result.durationMs});}
}
try{
  await save();progress('catalog',{directory,model:config.model,reasoningEffort:'max'});
  const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});
  report.catalog=catalog.items.find(item=>item.id===config.model);
  assert.ok((report.catalog as {reasoningEfforts?:string[]}|undefined)?.reasoningEfforts?.includes('max'),'Requested model/effort is not available');
  node=await buildApp(config);
  const settings=node.lifecycle.settings();
  for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;
  node.lifecycle.configure(settings);await node.app.ready();
  assert.equal(node.modelSettings.current().model,config.model);assert.equal(node.modelSettings.current().reasoningEffort,'max');
  for(const id of selected)await runCase(supplied.cases.find(c=>c.id===id)!);
  report.status=cases.every(c=>c.status==='passed')?'passed':'failed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  report.finishedAt=new Date().toISOString();await save();await node?.app.close();
  progress('finished',{status:report.status,report:join(directory,'report.json')});
}
