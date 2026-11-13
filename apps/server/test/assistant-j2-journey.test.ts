import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {estimateSerializedTokens} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {FileObservationReader} from '../src/file-observations.js';
import {AssistantFollowup} from '../src/assistant-followup.js';
import {sha256} from '../src/store.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

const token='generated-j2-owner',headers={authorization:'Bearer '+token};
const requirement='GENERATED REQUIREMENT: every plan needs a named owner.';
const missing='GENERATED DRAFT: the owner is not named.';
const complete='GENERATED DRAFT: Alex is the named owner.';
const secret='GENERATED EXCLUDED SOURCE: confidential sentinel.';
const pause=(ms=25)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>T|Promise<T>,label:string,timeout=8000):Promise<NonNullable<T>>{
 const deadline=Date.now()+timeout;let value:T;
 do{value=await read();if(value)return value as NonNullable<T>;await pause();}while(Date.now()<deadline);
 throw Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

async function journey(t:TestContext,interruption?:'restart'|'off'|'stop'|'exclude'){
 const directory=mkdtempSync(join(tmpdir(),'mote-j2-'));
 const held=Promise.withResolvers<void>();let entered=false;
 const requests:string[]=[],providerErrors:unknown[]=[],observations:ReturnType<FileObservationReader['read']>[]=[];
 const consumerErrors:string[]=[],originalTick=AssistantFollowup.prototype.tick;
 t.mock.method(AssistantFollowup.prototype,'tick',function(this:AssistantFollowup,...args:Parameters<typeof originalTick>){
  return originalTick.apply(this,args).catch(error=>{consumerErrors.push(error instanceof Error?error.message:String(error));throw error;});
 });
 const originalRead=FileObservationReader.prototype.read;
 t.mock.method(FileObservationReader.prototype,'read',function(this:FileObservationReader,input){const value=originalRead.call(this,input);observations.push(value);return value;});
 const provider=createServer((req,res)=>{void (async()=>{
  let wire='';for await(const chunk of req)wire+=chunk;requests.push(wire);
  const serialized=JSON.parse(wire);assert.ok(estimateSerializedTokens(serialized).tokens+512<=32000,'the complete controlled-provider request fits its declared 32k fixture window');
  const messages=serialized.messages as {content?:unknown}[];
  const texts=messages.flatMap(message=>typeof message.content==='string'?[message.content]:Array.isArray(message.content)?message.content.flatMap(part=>part.type==='text'?[part.text]:[]):[]);
  const inputs=texts.map(value=>{try{const envelope=JSON.parse(value);return typeof envelope.request==='string'?envelope.request:value;}catch{return value;}});
  const input=inputs.find(value=>value.includes('\nUntrusted context: '));
  if(!input)throw Error('Controlled provider did not receive an A14 context');
  const context=JSON.parse(input.slice(input.indexOf('\nUntrusted context: ')+'\nUntrusted context: '.length)) as {
   originals:{id:string;offset:number;quote:string}[];cards:{id:string;revision:number}[];memories:unknown[];
  };
  assert.deepEqual(context.memories,[],'the automatic path does not depend on a long-term Memory candidate');
  const proof=(needle:string)=>{const item=context.originals.find(value=>value.quote.includes(needle));assert.ok(item,`Generated original missing: ${needle}`);return {id:item.id,offset:item.offset+item.quote.indexOf(needle),quote:needle};};
  const all=JSON.stringify(context),cards=all.includes(complete)?[{action:'resolve',cardId:context.cards[0].id,relatedCardIds:[context.cards[0].id],title:'Generated owner assigned',body:'Alex is the named owner.',reason:'The updated draft names an owner.',evidence:[proof(complete)],matterId:null}]:
   all.includes(missing)?[{action:'new',cardId:null,relatedCardIds:[],title:'Generated owner missing',body:'The draft needs a named owner.',reason:'The requirement asks for an owner.',reminderReason:'The owner has not been named.',evidence:[proof(requirement),proof(missing)],matterId:null}]:[];
  const answer=JSON.stringify({reason:'Generated controlled interpretation',cards,commitments:[]});
  if(interruption&&requests.length===1){entered=true;await held.promise;}
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  send({id:'generated-j2',choices:[{index:0,delta:{role:'assistant',content:JSON.stringify({answer,citationIds:[]})},finish_reason:null}]});
  send({id:'generated-j2',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});res.end('data: [DONE]\n\n');
 })().catch(error=>{providerErrors.push(error);if(!res.headersSent)res.writeHead(500);res.end();});});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,dataKey:'65'.repeat(32),contentEncryptionEnabled:true,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,
  retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512,apiKey:'generated-only',allowUnauthenticatedLocal:false,
  embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 let node:Awaited<ReturnType<typeof buildApp>>,base='',now=Date.now();
 const start=async()=>{
  node=await buildApp(config,{backgroundWorker:false});
  // Test-only bypass of the explicitly blocked production C5 batch budget gate.
  (node.batchProcessing as unknown as {modelAdmission:()=>undefined}).modelAdmission=()=>undefined;
  (node.assistantChanges as unknown as {now:()=>number}).now=()=>now;
  base=await node.app.listen({host:'127.0.0.1',port:0});
 };
 await start();
 t.after(async()=>{held.resolve();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const call=async(method:string,url:string,payload?:unknown)=>{const response=await fetch(base+url,{method,headers:{...headers,...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});const value=await response.json();assert.ok(response.ok,`${url}: ${response.status} ${JSON.stringify(value)}`);return value as any;};
 const upload=async(revision:string,previousRevision:string|null,text:string)=>{
  const bytes=Buffer.from(text),item={externalId:'plan.txt',revision,observedAt:new Date().toISOString(),title:'Generated plan',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false};
  const manifest={sourceId:'j2-files',relativePath:'plan.txt',previousRevision,item,sizeBytes:bytes.length,sha256:sha256(bytes)};
  const started=await call('POST','/api/file-sync/v1/uploads',manifest);
  const part=await fetch(base+`/api/file-sync/v1/uploads/${started.uploadId}/parts/0`,{method:'PUT',headers:{...headers,'content-type':'application/octet-stream'},body:bytes});assert.equal(part.status,200,await part.text());
  const result=await call('POST',`/api/file-sync/v1/uploads/${started.uploadId}/commit`,{});
  await node.processing.tick();await node.materialOrganizer.tick(100);node.assistantChanges.tick();
  return result.id as string;
 };
 await call('POST','/api/sources',{id:'j2-files',name:'Generated plan files',kind:'local-files',deviceId:'j2-device',platform:'macos',retention:'archive'});
 await call('POST','/api/sources',{id:'j2-excluded',name:'EXCLUDED_J2_TITLE',kind:'custom',deviceId:'j2-device',platform:'import',retention:'archive'});
 await call('PUT','/api/sources/j2-excluded/items',{externalId:'EXCLUDED_J2_PATH',revision:'1',observedAt:new Date().toISOString(),kind:'message',layer:'original',text:secret,deleted:false});
 const noteId=randomUUID();await call('POST','/api/notes',{id:noteId,deviceId:'j2-device',deviceName:'Generated',platform:'android',capturedAt:new Date().toISOString(),text:requirement});
 const settings={...node.processing.view().settings,enabled:true,summarize:false};await node.processing.save({revision:node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,node.processing.runtime.registry)});
 const configuration=await call('GET','/api/configuration');
 await call('PUT','/api/configuration/notifications',{revision:configuration.revision,value:{enabled:true,timeZone:'UTC',quietHours:null,minIntervalMinutes:60}});
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM memories').get()!.n,0);
 const initial=await upload('0',null,'GENERATED DRAFT: planning has started.');
 const changed=await upload('1','0',missing);assert.notEqual(changed,initial);
 let control=await call('GET','/api/model-authorization');
 await call('POST','/api/model-authorization/commands',{action:'exclude',revision:control.authorization.revision,operationId:randomUUID(),excludedSourceIds:['j2-excluded']});
 control=await call('GET','/api/model-authorization');await call('POST','/api/model-authorization/commands',{action:'on',revision:control.authorization.revision,operationId:randomUUID()});
 await node.materialOrganizer.tick(100);node.assistantChanges.tick();now+=60001;
 const ready=node.assistantChanges.ready().find(item=>item.input.captureId===changed);assert.ok(ready,'A4 has the processed real version ready for its consumer');
 // Poll the real organizer after advancing the controlled settling clock. Its
 // production completion callback must hand the durable input to the consumer.
 await node.materialOrganizer.tick(100);
 const scope={kind:'all' as const},scopeQuery=new URLSearchParams({scope:JSON.stringify(scope)}),cardsPath='/api/assistant-cards?'+scopeQuery;
 const command=async(action:'on'|'off'|'stop'|'exclude',excludedSourceIds?:string[])=>{
  const state=await call('GET','/api/model-authorization');
  return call('POST','/api/model-authorization/commands',{action,revision:state.authorization.revision,operationId:randomUUID(),...(excludedSourceIds?{excludedSourceIds}:{})});
 };
 if(interruption){
  await until(()=>{if(providerErrors.length)throw providerErrors[0];return entered;},'the real automatic provider request before its response');
  const batchId=String(node.store.db.prepare('SELECT started_batch FROM assistant_change_work WHERE capture_id=?').get(changed)!.started_batch);
  if(interruption==='restart'){await node.app.close();held.resolve();await start();}
  else {await command(interruption,interruption==='exclude'?['j2-excluded','device:j2-device']:undefined);held.resolve();}
  if(interruption==='stop'||interruption==='exclude'){
   await until(()=>node.batchProcessing.progress(batchId).items.some(item=>interruption==='stop'?item.state==='cancelled':
    item.state==='waiting'&&item.error==='background_model_authorization_required'),'the automatic batch to honor the owner control');
   if(interruption==='stop')await until(()=>node.store.db.prepare("SELECT f.state FROM task_records b JOIN task_records f ON f.operation_id=b.operation_id WHERE b.id=? AND f.kind='assistant.followup'").get(batchId)?.state==='cancelled','the file analysis to project its cancellation');
   assert.deepEqual((await call('GET',cardsPath)).items,[],'the held response cannot publish after stop or a context-source exclusion');
   assert.deepEqual((await call('GET','/api/assistant-notifications?'+scopeQuery)).items,[]);
   if(interruption==='exclude')await command('exclude',['j2-excluded']);
   await command('on');const calls=requests.length;
   await node.materialOrganizer.tick(100);node.assistantChanges.tick();await node.executor.tick();
   assert.equal(node.assistantChanges.ready().length,0,'re-enabling cannot re-admit a consumed original');
   assert.equal(node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.followup'").get()!.n,1,'the same admitted analysis retains its identity');
   assert.equal(requests.length,calls);assert.deepEqual((await call('GET',cardsPath)).items,[]);return;
  }
 }
 const first=await until(async()=>{if(providerErrors.length)throw providerErrors[0];return (await call('GET',cardsPath)).items.find((card:any)=>card.state==='open');},`automatic suggestion for A4 task ${ready.task.id}`).catch(error=>{
  const work=node.store.db.prepare('SELECT started_batch FROM assistant_change_work WHERE task_id=?').get(ready.task.id);
  const followups=node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.followup'").get()!.n;
  const steps=work?.started_batch?node.batchProcessing.progress(String(work.started_batch)).items.map(item=>({state:item.state,error:item.error})):[];
  const trace=node.diagnostics.recent(15).map(item=>({event:item.event,type:item.trace?.type}));
  throw Error(`No automatic suggestion: batch=${String(work?.started_batch??'none')}, followups=${followups}, providerRequests=${requests.length}, steps=${JSON.stringify(steps)}, consumerErrors=${JSON.stringify(consumerErrors)}, trace=${JSON.stringify(trace)}`,{cause:error});
 });
 assert.ok(requests.length>0,'the controlled provider received the real analysis');
 assert.ok(observations.some(value=>value.current.captureId===changed),'the actual F12 observation fed the consumer');
 assert.ok(requests.some(wire=>wire.includes(requirement)&&wire.includes(missing)),'the provider saw both the old requirement and the changed document');
 assert.ok(requests.every(wire=>![secret,'EXCLUDED_J2_TITLE','EXCLUDED_J2_PATH','j2-excluded'].some(value=>wire.includes(value))),'no excluded source body, title, path or identity enters an actual provider request');
 assert.equal(first.evidence.some(value=>value.quote===requirement),true);assert.equal(first.evidence.some(value=>value.quote===missing),true);
 const changedTask=node.store.db.prepare('SELECT started_batch FROM assistant_change_work WHERE capture_id=?').get(changed);assert.ok(changedTask?.started_batch,'the file version points at the real queued batch');
 const firstAnalysis=node.store.db.prepare("SELECT f.id,f.state FROM task_records b JOIN task_records f ON f.operation_id=b.operation_id WHERE b.id=? AND f.kind='assistant.followup'").get(changedTask.started_batch)!;
 assert.equal(firstAnalysis.state,'succeeded');assert.equal(first.version,`followup:${firstAnalysis.id}:0`);
 assert.ok(node.store.db.prepare('SELECT 1 FROM task_evidence WHERE task_id=? AND evidence_id=?').get(changedTask.started_batch,changed));
 assert.ok(node.store.db.prepare('SELECT 1 FROM task_evidence WHERE task_id=? AND evidence_id=?').get(changedTask.started_batch,noteId));
 const beforeNotices=await call('GET','/api/assistant-notifications?'+scopeQuery);
 assert.equal(beforeNotices.items.filter((item:any)=>item.id===first.id).length,1,'a real eligible reminder exists before resolving the issue');
 const revised=await upload('2','1',complete);assert.notEqual(revised,changed);now+=60001;
 if(interruption==='off'){
  assert.equal(node.assistantChanges.ready().length,0,'off withholds the newly uploaded version');
  assert.equal(node.store.db.prepare('SELECT started_batch FROM assistant_change_work WHERE capture_id=?').get(revised)!.started_batch,null);
  await command('on');
 }
 await node.materialOrganizer.tick(100);
 const final=await until(async()=>{if(providerErrors.length)throw providerErrors[0];const page=await call('GET',cardsPath);return page.items.find((card:any)=>card.id===first.id&&card.state==='resolved');},'the same suggestion to resolve');
 assert.ok(final.revision>first.revision);assert.ok(final.evidence.some(value=>value.quote===complete));
 assert.equal((await call('GET',cardsPath)).items.filter((card:any)=>card.id===first.id).length,1);
 assert.ok(observations.some(value=>value.current.captureId===revised));
 assert.ok(requests.every(wire=>![secret,'EXCLUDED_J2_TITLE','EXCLUDED_J2_PATH','j2-excluded'].some(value=>wire.includes(value))));
 const notices=await call('GET','/api/assistant-notifications?'+scopeQuery);assert.equal(notices.items.some((item:any)=>item.id===first.id),false);
 const finalBatch=node.store.db.prepare('SELECT started_batch FROM assistant_change_work WHERE capture_id=?').get(revised)?.started_batch;assert.ok(finalBatch);
 const finalAnalysis=node.store.db.prepare("SELECT f.id,f.state FROM task_records b JOIN task_records f ON f.operation_id=b.operation_id WHERE b.id=? AND f.kind='assistant.followup'").get(finalBatch)!;
 assert.equal(finalAnalysis.state,'succeeded');assert.equal(final.version,`followup:${finalAnalysis.id}:0`);
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.followup'").get()!.n,2,'only the two original input groups were analyzed');
 assert.equal(node.assistantChanges.ready().length,0,'derived card publications do not become new automatic inputs');
 const calls=requests.length;await node.materialOrganizer.tick(100);node.assistantChanges.tick();await node.executor.tick();
 assert.equal(requests.length,calls,'polling without a new original does not repeat a reminder or model request');
 assert.deepEqual(consumerErrors,[]);
}

test('J2 a real file change generates and resolves one suggestion without sending an excluded source',t=>journey(t));
test('a queued automatic file review resumes after restart with the same analysis and suggestion',t=>journey(t,'restart'));
test('off drains the admitted file review and withholds the next review until on',t=>journey(t,'off'));
test('stop rejects a held automatic file response without re-admitting its original',t=>journey(t,'stop'));
test('excluding a note used by the file review fences its held response and retains the admitted analysis identity',t=>journey(t,'exclude'));
