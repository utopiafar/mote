/** Explicitly opt-in local acceptance. Native logs and all derived personal
 * text stay in a private temporary workspace, never the repository/report.
 * --live uses only local Codex App Server with the requested gpt-6.1-sol. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,chmod,rm,writeFile,readFile,stat,readdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {scanCodingAgent,type CodingProvider,type CodingCheckpoint} from '../apps/desktop/src/coding-agents.js';
import {DEFAULT_SOURCE_OPTIONS} from '../apps/desktop/src/source-types.js';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';
import {codingConversationEvidence,type SourceItem} from '@mote/shared';
import {CodexSession} from '../packages/agent/dist/codex-session.js';

assert.ok(process.argv.includes('--local-sample'),'Pass --local-sample after explicit owner authorization to read local Coding logs');
const live=process.argv.includes('--live'),home=homedir(),directory=await mkdtemp(join(tmpdir(),'mote-real-dialogue-'));
await chmod(directory,0o700);
const model='gpt-6.1-sol',token=randomBytes(32).toString('hex');
const config:Config={dataKey:'',dataDir:join(directory,'vault'),token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:256_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model,modelProvider:'codex',modelProtocol:'codex-app-server',modelReasoningEffort:'low',modelMaxTokens:8192,agentTimeoutMs:300000,modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:3};
const report:Record<string,unknown>={startedAt:new Date().toISOString(),model,live,realCodingData:true,physicalDeviceChecks:false,originalDatabaseModified:false};
const forbidden:string[]=[],samples:{provider:CodingProvider;files:string[]}[]=[];
async function filesUnder(path:string):Promise<string[]>{const result:string[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isDirectory())result.push(...await filesUnder(p));else if(entry.isFile()&&entry.name.endsWith('.jsonl'))result.push(p);}return result;}
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const transport=CodexSession.prototype as unknown as {send:(message:any)=>void},originalSend=transport.send;
let wireMessages=0,maxWireCharacters=0;
try{
 const override=process.env.MOTE_ACCEPTANCE_CLAUDE_FILE;
 const claudeFiles=override?[override]:(await filesUnder(join(home,'.claude/projects'))).filter(path=>!path.includes('/subagents/'));
 const claudeRanked=await Promise.all(claudeFiles.map(async path=>({path,size:(await stat(path)).size})));
 for(const {path} of claudeRanked.sort((a,b)=>b.size-a.size)){
  const sidechains=await readdir(join(path.slice(0,-6),'subagents')).catch(()=>[]);
  const compact=sidechains.find(name=>name.startsWith('agent-acompact-')&&name.endsWith('.jsonl'));
  if(compact){samples.push({provider:'claude',files:[path,join(path.slice(0,-6),'subagents',compact)]});break;}
 }
 assert.ok(samples.some(sample=>sample.provider==='claude'),'a native Claude compaction scenario is required');
 const codexFiles=await filesUnder(join(home,'.codex/sessions')),ranked=await Promise.all(codexFiles.map(async path=>({path,mtime:(await stat(path)).mtimeMs})));
 for(const {path} of ranked.sort((a,b)=>b.mtime-a.mtime).slice(0,80)){
  const rows=(await readFile(path,'utf8')).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  if(rows.some(r=>r.type==='session_meta'&&r.payload?.source&&typeof r.payload.source==='object'&&r.payload.source.subagent))continue;
  if(rows.some(r=>r.type==='response_item'&&r.payload?.phase==='final_answer')){samples.push({provider:'codex',files:[path]});break;}
 }
 const kimiFiles=(await filesUnder(join(home,'.kimi/sessions'))).filter(p=>basename(p)==='wire.jsonl');
 for(const path of kimiFiles){if((await stat(path)).size<100)continue;const body=await readFile(path,'utf8');if(body.split('\n').some(line=>{try{return JSON.parse(line).message?.type==='TurnBegin';}catch{return false;}})){samples.push({provider:'kimi',files:[path]});break;}}
 assert.ok(samples.some(sample=>sample.provider==='codex')&&samples.some(sample=>sample.provider==='kimi'),'real native Codex and Kimi samples are required');
 node=await buildApp(config,{backgroundWorker:false});await node.app.ready();
 const settings=node.lifecycle.settings();for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);
 const counters:unknown[]=[];
 for(const sample of samples){
  const root=join(directory,'input',sample.provider);await mkdir(root,{recursive:true,mode:0o700});
  for(const path of sample.files){const folder=join(root,basename(dirname(path)));await mkdir(folder,{recursive:true,mode:0o700});const dest=join(folder,basename(path));await copyFile(path,dest);await chmod(dest,0o600);}
  const items:SourceItem[]=[];let checkpoint:CodingCheckpoint|undefined;
  for(let n=0;n<300;n++){
   const scan=await scanCodingAgent(root,sample.provider,DEFAULT_SOURCE_OPTIONS,checkpoint);checkpoint=scan.checkpoint as CodingCheckpoint|undefined;
   const observedAt=new Date().toISOString();
   for(const item of scan.items){const {syncQueue:_queue,...wire}=item;const value={...wire,observedAt,revision:createHash('sha256').update(JSON.stringify(wire)).digest('hex')} as SourceItem;items.push(value);}
   if(scan.complete)break;assert.ok(n<299,'native scanner did not finish');
  }
  const unique=[...new Map(items.map(item=>[item.externalId,item])).values()];const id='real-'+sample.provider;
  node.sources.register({id,name:'Owner-authorized real Coding acceptance',kind:'coding-agent',deviceId:'local-acceptance',platform:'macos'});node.sourcePipelines.configure(id,{settleSeconds:0});
  for(let i=0;i<unique.length;i+=100)await node.sources.upsertBatch(id,unique.slice(i,i+100));
  await node.sourcePipelines.tick(100);
  const materials=node.materials.list({kind:'mote.coding-session'}).items.filter(m=>m.origin.sourceId===id);
  const visible=materials.flatMap(m=>node!.materials.evidence(node!.materials.evidenceIds(m.ref))).map(r=>r.ocrText).join('\n');
  const denied=items.filter(item=>!codingConversationEvidence(item.document!.coding!));
  for(const item of denied)if(item.text.length>=100){const needle=item.text.slice(0,160);if(!visible.includes(needle))forbidden.push(needle);}
  assert.ok(unique.length>0&&materials.length>0,'provider sample produced no dialogue');assert.ok(materials.every(m=>m.schemaVersion===6));
  for(const text of forbidden)assert.ok(!visible.includes(text),'process body entered indexed dialogue');
  counters.push({provider:sample.provider,nativeFiles:sample.files.length,uploadedParts:unique.length,duplicateParts:items.length-unique.length,uploadedCharacters:items.reduce((n,i)=>n+i.text.length,0),dialogueCharacters:materials.reduce((n,m)=>n+m.textLength,0),materials:materials.length});
 }
 report.sources=counters;
 transport.send=function(message:any){
  if(message.method==='turn/start'||message.result?.contentItems){const value=JSON.stringify(message);for(const needle of forbidden)assert.ok(!value.includes(JSON.stringify(needle).slice(1,-1)),'excluded process text reached Codex wire');wireMessages++;maxWireCharacters=Math.max(maxWireCharacters,value.length);}
  return originalSend.call(this,message);
 };
 if(live){
  const policy=node.workflows.settings();node.workflows.configure({...policy,semantic:{...policy.semantic,concurrency:3}});
  let calls=0;const query=node.agent.query.bind(node.agent);
  node.agent.query=async input=>{assert.ok(++calls<=24,'live call budget exceeded');assert.ok(!input.question.startsWith('Build a running overview'));
   const ranges=input.evidenceRanges??[];assert.ok(ranges.reduce((n,r)=>n+r.length,0)<=12000);
   const evidence=node!.memories.readEvidence(input.evidenceIds??[]);for(const r of evidence)for(const needle of forbidden)assert.ok(!r.ocrText.includes(needle));
   console.log(JSON.stringify({stage:'model',call:calls,phase:input.traceContext?.phase??'understanding',rangeCharacters:ranges.reduce((n,r)=>n+r.length,0)}));return query(input);};
  const material=node.materials.list({kind:'mote.coding-session'}).items.find(m=>m.origin.sourceId==='real-claude');assert.ok(material);
  const ids=node.materials.evidenceIds(material.ref),recipes=[{id:'mote.personal-memory',version:'2'},{id:'mote.coding-memory',version:'2'}];
  const created=recipes.map(recipe=>node!.memoryPipeline.create({evidenceIds:ids,recipes:[recipe],contextTime:new Date().toISOString(),batchCharacters:12000}));
  const jobs=await Promise.all(created.map(j=>node!.memoryPipeline.run(j.id)));
  report.jobs=jobs.map(j=>({status:j.status,batches:j.totalBatches,failed:j.failedBatches,memories:j.memoryIds.length,error:j.errorCode}));
  assert.ok(jobs.every(j=>j.status==='completed'),JSON.stringify(report.jobs));
  const before=calls;await Promise.all(jobs.map(j=>node!.memoryPipeline.run(j.id)));assert.equal(calls,before,'completed jobs replayed paid queries');
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM processing_jobs WHERE state='stale'").get()!.n,0);
  assert.ok(wireMessages>0,'Codex transport audit did not observe actual RPC');
  report.modelCalls=calls;report.wireMessages=wireMessages;report.maxWireCharacters=maxWireCharacters;
 }
 report.status='passed';console.log(JSON.stringify({stage:'accepted',...report}));
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;console.log(JSON.stringify({stage:'failed',...report}));}
finally{transport.send=originalSend;report.finishedAt=new Date().toISOString();await writeFile(join(tmpdir(),`mote-real-dialogue-${live?'live':'rules'}-acceptance.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});await node?.app.close();await rm(directory,{recursive:true,force:true});}
