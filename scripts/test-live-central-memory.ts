// Opt-in: real model, synthetic files, real loopback HTTP, isolated archive.
// Never load the owner's data/connector configuration or persist credentials.
import {readFile,writeFile,mkdir,chmod,stat} from 'node:fs/promises';
import {writeFileSync,appendFileSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';
import {createImportAgent} from '@mote/agent';
import {modelSettingsFromConfig} from '../apps/server/src/model-agent.js';
import {prepareImportInput} from '../apps/server/src/import-runtime.js';
import {preparePrivateImportLaunch} from './private-import-runtime.js';
import {createLiveModelRelay} from './live-model-relay.js';
// Fixture module also supports plain Node for independent human review.
// @ts-expect-error This data-only fixture is intentionally JavaScript.
import {rounds,reviewRubric} from './fixtures/central-live-fixtures.mjs';

type Round={id:string;title:string;packageAsZip?:boolean;files:{name:string;text:string;mimeType:string}[];instruction:string;expectedRecords:{count:number;externalIds:string[];currentCount?:number;currentRevision?:string};expectedMemory:{minimumUsefulCandidates:number};questions:{id:string;question:string;expectations:string[]}[];insightPrompt:string};
const args=process.argv.slice(2),option=(name:string)=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
assert.ok(option('--env-file')&&option('--out'),'Usage: node --import tsx scripts/test-live-central-memory.ts --env-file PRIVATE_ENV --out .mote/NEW_RUN [--only ROUND,...] [--resume]');
assert.ok(args.includes('--private-import')||args.includes('--read-only'),'Select --private-import (restricted macOS import) or --read-only (imports disabled)');
const out=resolve(option('--out')!),privateRoot=resolve('.mote'),part=relative(privateRoot,out);
assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part),'Output must be a new directory below .mote');
if(!args.includes('--resume'))assert.equal(await stat(out).then(()=>true,()=>false),false,'Use a new output directory or explicit --resume');
await mkdir(out,{recursive:true,mode:0o700});await chmod(out,0o700);
const env=parseEnv(await readFile(resolve(option('--env-file')!),'utf8'));
assert.ok(env.MOTE_MODEL_API_KEY?.trim(),'Selected env file has no model key');
assert.equal(env.MOTE_MODEL_PROVIDER||'deepseek','deepseek','This runner targets the configured DeepSeek connection');
assert.equal(new URL(env.MOTE_MODEL_BASE_URL||'https://api.deepseek.com').origin,'https://api.deepseek.com');
const config:Config={dataDir:join(out,'data'),dataKey:undefined,token:randomUUID()+randomUUID(),tokenPath:'unused',profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:256*1024*1024,maxExportBytes:32*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:env.MOTE_MODEL!,modelProvider:'deepseek',modelProtocol:'deepseek',modelBaseUrl:env.MOTE_MODEL_BASE_URL||'https://api.deepseek.com',apiKey:env.MOTE_MODEL_API_KEY!,allowUnauthenticatedLocal:false,modelReasoningEffort:'high',modelMaxTokens:8192,modelTimeoutMs:300000,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true,logLevel:'silent'};
const save=async(name:string,value:unknown)=>writeFile(join(out,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const report:any=args.includes('--resume')?JSON.parse(await readFile(join(out,'summary.json'),'utf8')):{model:config.model,provider:'deepseek',startedAt:new Date().toISOString(),generatedFixturesOnly:true,transport:'real HTTP to isolated loopback server; live Harness model connection',rounds:{}};
assert.equal(report.generatedFixturesOnly,true,'Only resume this synthetic runner archive');
await save('rubric.json',reviewRubric);
const importLogBytes=new Map<string,number>();
const relay=args.includes('--private-import')&&!args.includes('--read-only')?await createLiveModelRelay(config.apiKey!,config.model):undefined;
const observeImport=(workspace:string,event:unknown)=>{
  const id=basename(workspace),bytes=importLogBytes.get(id)??0;if(bytes>16*1024*1024)return;
  let line=JSON.stringify({at:new Date().toISOString(),event}).replaceAll(config.apiKey!,'[redacted]').replaceAll(config.token,'[redacted]');if(relay)line=line.replaceAll(relay.apiKey,'[redacted]');line+='\n';
  appendFileSync(join(out,`import-runtime-${id}.jsonl`),line,{mode:0o600});importLogBytes.set(id,bytes+Buffer.byteLength(line));
};
const node=await buildApp(config,{prepareImport:async input=>{
  if(!relay)throw Error('Import execution is disabled in read-only validation');
  const runtime=createImportAgent({...modelSettingsFromConfig(config),baseUrl:relay.baseUrl,apiKey:relay.apiKey},async paths=>{
    const launch=await preparePrivateImportLaunch({...paths,relayPort:relay.port});await writeFile(join(out,`import-policy-${basename(input.workspace)}.sb`),await readFile(launch.profilePath),{mode:0o600});return launch;
  });
  try{return await runtime.prepare(await prepareImportInput(input),event=>observeImport(input.workspace,event));}finally{await runtime.close();}
}}).catch(async error=>{await relay?.close();throw error;});
report.importRuntime=relay?'macOS file restrictions; exact loopback relay; no provider key in import child':'imports disabled';
// Observe actual runtime results; these wrappers do not substitute an agent or answer.
const liveQuery=node.agent.query.bind(node.agent);
node.agent.query=async input=>{const result=await liveQuery(input);await save(`model-${input.skill??'query'}-${result.runId}.json`,{input,result});return result;};
const extract=node.memories.extract.bind(node.memories);
node.memories.extract=(result,model,options)=>{try{return extract(result,model,options);}catch(error){writeFileSync(join(out,`memory-validation-${result.runId}.json`),JSON.stringify({result,error:String(error instanceof Error?error.message:error)},null,2),{mode:0o600});throw error;}};
await node.app.listen({host:'127.0.0.1',port:0});
const address=node.app.server.address();assert.ok(address&&typeof address==='object');
const base=`http://127.0.0.1:${address.port}`;
async function request(method:string,path:string,payload?:unknown){
  const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${config.token}`,...(payload===undefined?{}:{'content-type':'application/json'})},body:payload===undefined?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(360000)});
  const body=await response.json();return {status:response.status,body};
}
async function read(path:string){const result=await request('GET',path);assert.equal(result.status,200);return result.body as any;}
async function poll(path:string,active:string[]){
  const deadline=Date.now()+420000;
  while(Date.now()<deadline){const value=await read(path);if(!active.includes(value.status))return value;await new Promise(resolve=>setTimeout(resolve,1000));}
  throw Error('Live job polling exceeded seven minutes');
}
function progress(round:string,stage:string,details:Record<string,unknown>={}){console.info(JSON.stringify({round,stage,...details}));}
async function checkpoint(){report.updatedAt=new Date().toISOString();await save('summary.json',report);}
try{
  for(const round of (rounds as Round[]).filter(r=>!option('--only')||option('--only')!.split(',').includes(r.id))){
    const result=report.rounds[round.id]??={title:round.title,attempts:[],queries:[]};
    await save(round.id+'-fixture.json',round);
    try{
      let job:any=result.importId?await read('/api/imports/'+result.importId):undefined;
      if(args.includes('--read-only'))assert.equal(job?.status,'completed','Read-only validation requires an already completed synthetic import');
      if(!job){
        const files=round.packageAsZip?[{name:round.id+'.zip',mimeType:'application/zip',dataBase64:Buffer.from(zipSync(Object.fromEntries(round.files.map(file=>[file.name,strToU8(file.text)])))).toString('base64')}]:round.files.map(file=>({name:file.name,mimeType:file.mimeType,dataBase64:Buffer.from(file.text).toString('base64')}));
        progress(round.id,'upload');const uploaded=await request('POST','/api/imports',{name:round.title,instruction:round.instruction,files});assert.equal(uploaded.status,202);job=uploaded.body;result.importId=job.id;result.startedAt=Date.now();await checkpoint();
      }else if(['failed','unsupported'].includes(job.status)){
        progress(round.id,'retry-import');assert.equal((await request('POST',`/api/imports/${job.id}/retry`)).status,202);
      }
      job=await poll('/api/imports/'+job.id,['queued','preparing']);
      result.attempts.push({stage:'prepare',status:job.status,elapsedMs:Date.now()-(result.startedAt??Date.now())});await save(round.id+`-preview-${result.attempts.length}.json`,job);await checkpoint();
      assert.ok(['awaiting_confirmation','completed'].includes(job.status),'Import preparation failed: '+(job.error??job.status));
      if(job.status==='awaiting_confirmation'){
        assert.equal(job.preview.count,round.expectedRecords.count,'Unexpected record count in preview');
        progress(round.id,'confirm',{records:job.preview.count});assert.equal((await request('POST',`/api/imports/${job.id}/confirm`)).status,202);
      }
      job=await poll('/api/imports/'+job.id,['awaiting_confirmation','importing']);await save(round.id+'-imported.json',job);assert.equal(job.status,'completed');
      const records=await Promise.all(job.captureIds.map((id:string)=>read('/api/captures/'+id)));await save(round.id+'-records.json',records);
      assert.deepEqual(records.map((r:any)=>r.provenance.externalId).sort(),[...round.expectedRecords.externalIds].sort());
      for(const record of records){assert.ok(record.provenance.document.fileId);const original=await fetch(base+'/api/archived-files/'+record.provenance.document.fileId+'/content',{headers:{authorization:`Bearer ${config.token}`}});assert.equal(original.status,200);const expected=round.files.find(file=>file.name===basename(record.provenance.document.path));assert.ok(expected,'Original reference must resolve to a supplied fixture');assert.deepEqual(Buffer.from(await original.arrayBuffer()),Buffer.from(expected.text),'Archived original bytes changed');}
      result.imported=records.length;result.deviceId=records[0].deviceId;result.sourceId=job.sourceId;
      const currentItems=await read(`/api/sources/${job.sourceId}/items`);await save(round.id+'-source-items.json',currentItems);assert.equal(currentItems.items.length,round.expectedRecords.currentCount??round.expectedRecords.count);
      if(round.expectedRecords.currentRevision){const history=await read(`/api/sources/${job.sourceId}/history?externalId=${encodeURIComponent(round.expectedRecords.externalIds[0])}`);await save(round.id+'-history.json',history);assert.equal(history.items.length,round.expectedRecords.count);const current=await read(`/api/sources/${job.sourceId}/item?externalId=${encodeURIComponent(round.expectedRecords.externalIds[0])}`);assert.equal(current.item.revision,round.expectedRecords.currentRevision);}
      assert.ok(job.memoryJobId,'Import did not enqueue Memory');
      let memory=await poll('/api/memory-jobs/'+(result.memoryJobId??job.memoryJobId),['queued','running']);
      if(args.includes('--refresh-memories')){
        const skills=await read('/api/skills'),version=skills.items.find((skill:any)=>skill.id==='memory-extraction').version;
        assert.notEqual(memory.skillVersion,`memory-extraction@${version}`,'Refresh requires a changed Skill version so explicit forget checkpoints remain respected');
        const before=await Promise.all(memory.memoryIds.map((id:string)=>read('/api/memories/'+id)));await save(round.id+`-memories-before-refresh-${memory.id}.json`,{job:memory,items:before});
        for(const id of memory.memoryIds)assert.equal((await request('DELETE','/api/memories/'+id)).status,200);
        const created=await request('POST','/api/memory-jobs',{evidenceIds:memory.evidenceIds,timeZone:'Asia/Shanghai'});assert.equal(created.status,202);result.memoryJobId=(created.body as any).id;await checkpoint();
        progress(round.id,'refresh-memory');memory=await poll('/api/memory-jobs/'+result.memoryJobId,['queued','running']);
      }
      if(memory.status==='failed'&&args.includes('--resume')){await save(round.id+'-memory-before-retry.json',memory);progress(round.id,'retry-memory');assert.equal((await request('POST',`/api/memory-jobs/${memory.id}/retry`)).status,202);memory=await poll('/api/memory-jobs/'+memory.id,['queued','running']);}
      await save(round.id+'-memory-job.json',memory);assert.equal(memory.status,'completed','Memory job failed: '+memory.errorCode);
      const memories=await Promise.all(memory.memoryIds.map((id:string)=>read('/api/memories/'+id)));await save(round.id+'-memories.json',memories);
      for(const m of memories)for(const evidence of m.evidence){const source=await read('/api/captures/'+evidence.id);assert.equal(source.ocrText.slice(evidence.offset,evidence.offset+evidence.length),evidence.quote,'Memory quote must match exact original range');assert.ok(evidence.fileId,'Memory must resolve to an archived original');}
      result.memories=memories.length;assert.ok(memories.length>=round.expectedMemory.minimumUsefulCandidates,'No useful Memory candidates produced');progress(round.id,'memory-completed',{count:memories.length});await checkpoint();
      for(const question of round.questions){
        if(!args.includes('--repeat-queries')&&result.queries.some((q:any)=>q.id===question.id&&q.validated))continue;
        progress(round.id,question.id);const started=Date.now(),response=await request('POST','/api/query',{question:question.question,deviceId:result.deviceId,timeZone:'Asia/Shanghai'});await save(question.id+`-response-${result.queries.length+1}.json`,{question,...response});
        const body=response.body as any;const entry={id:question.id,status:response.status,durationMs:Date.now()-started,citations:body.citations?.length??0,tools:body.trace?.map((s:any)=>s.tool)??[],validated:false};result.queries.push(entry);await checkpoint();progress(round.id,'answer-completed',entry);assert.equal(response.status,200,'Question failed');assert.ok(body.citations?.length,'Expected supported answer citations');
        for(const citation of body.citations){const source=await read('/api/captures/'+citation.id);assert.equal(source.provenance.sourceId,result.sourceId,'Citation escaped selected fixture source');}
        entry.validated=true;await checkpoint();
      }
      if(args.includes('--repeat-insights')||!result.insight||result.insight.status!==200||!result.insight.artifact){
        progress(round.id,'insight');const started=Date.now(),response=await request('POST','/api/insights',{prompt:round.insightPrompt,deviceId:result.deviceId,timeZone:'Asia/Shanghai'});const body=response.body as any;
        await save(round.id+`-insight-${result.attempts.length}.json`,response);result.insight={status:response.status,durationMs:Date.now()-started,artifact:Boolean(body.artifact?.html),citations:body.citations?.length??0};await checkpoint();assert.equal(response.status,200);assert.ok(body.artifact?.html,'Insight omitted generated HTML');await writeFile(join(out,round.id+'-report.html'),body.artifact.html,{mode:0o600});
      }
      delete result.error;result.mechanicalChecks='pass';result.semanticReview='pending';progress(round.id,'round-completed',{records:result.imported,memories:result.memories});
    }catch(error){result.error=String(error instanceof Error?error.message:error).replaceAll(config.apiKey,'[redacted]').slice(0,1500);result.mechanicalChecks='fail';progress(round.id,'round-failed',{error:result.error});}
    await checkpoint();
  }
  if(args.includes('--mixed-query')){
    const question='请结合现有资料，简短核对三件事：林澄最新明确的咖啡要求是什么奶、是否加糖；连续六周晨跑五公里是谁的自述；青石交流会是否举行、林澄是否参加？每项给对应原文出处。';
    progress('mixed','query');const started=Date.now(),response=await request('POST','/api/query',{question,timeZone:'Asia/Shanghai'});
    await save('mixed-query.json',{question,...response});assert.equal(response.status,200);report.mixedQuery={status:response.status,durationMs:Date.now()-started,semanticReview:'pending'};
  }
}finally{try{await node.app.close();}finally{await relay?.close();await checkpoint();}}
if(Object.values(report.rounds).some((r:any)=>r.mechanicalChecks!=='pass'))process.exitCode=1;
