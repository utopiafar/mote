import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {estimateSerializedTokens} from '@mote/agent';
import type {ModelDomain} from '@mote/shared/models';

const at='2026-11-01T00:00:00.000Z',headers={authorization:'Bearer generated-budget-owner'};
async function fixture(t:TestContext,window=272000){
 const root=mkdtempSync(join(tmpdir(),'mote-followup-native-')),requests:any[]=[];
 let completionGate:Promise<void>|undefined;
 let node!:Awaited<ReturnType<typeof buildApp>>;
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||!req.url?.endsWith('/responses')){res.writeHead(404).end();return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks),body=JSON.parse((req.headers['content-encoding']==='zstd'?zstdDecompressSync(raw):raw).toString());
  requests.push(body);
  assert.ok(estimateSerializedTokens(body).tokens+128000<=window,'every actual complete provider payload retains the native output reserve');
  assert.equal(body.max_output_tokens,undefined);
  assert.equal(body.service_tier,'priority','the assembled follow-up uses the production Terra Fast selection');
  const previous=body.input.findLast((item:any)=>item.type==='function_call_output');
  if(previous)await completionGate;
  const message=body.input.findLast((item:any)=>item.type==='message'&&item.role==='user');
  const envelope=JSON.parse(message.content.find((part:any)=>part.type==='input_text').text);
  const grant=envelope.authorizedContextRanges.ranges.at(-1);
  const output=previous?[{id:'generated-final',type:'message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:JSON.stringify({answer:JSON.stringify({reason:'Generated bounded review completed.',cards:[],commitments:[]}),citationIds:[]}),annotations:[]}]}]:[
   {id:'generated-read',type:'function_call',call_id:'generated-read',name:'context_evidence',arguments:JSON.stringify({id:grant.id,offset:Math.max(0,grant.length-100),length:100}),status:'completed'},
  ];
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(type:string,value:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value as object})}\n\n`);
  send('response.created',{response:{id:'generated-response-'+requests.length,status:'in_progress'}});
  for(const [output_index,item] of output.entries()){send('response.output_item.added',{output_index,item});send('response.output_item.done',{output_index,item});}
  send('response.completed',{response:{id:'generated-response-'+requests.length,status:'completed',output,usage:{input_tokens:100,output_tokens:10,total_tokens:110}}});res.end();
 });
 server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const executable=join(root,'native-wrapper.mjs'),origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const catalog=join(root,'generated-models.json');
 writeFileSync(catalog,JSON.stringify({models:[{slug:'gpt-6.1-terra',display_name:'Generated Terra Fast catalog',description:'Generated fixture',model_messages:{instructions_template:'Generated fixture model instructions.'},default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'medium',description:'Generated fixture'}],shell_type:'shell_command',visibility:'list',supported_in_api:true,priority:0,supports_reasoning_summary_parameter:true,support_verbosity:false,truncation_policy:{mode:'tokens',limit:10000},context_window:272000,effective_context_window_percent:95,experimental_supported_tools:[],service_tiers:[{id:'priority',name:'Fast',description:'Generated Fast capability'}],additional_speed_tiers:['fast']}]}),{mode:0o600});
 writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused-credential'}),{mode:0o600});
 writeFileSync(executable,`#!${process.execPath}\nimport {spawn} from 'node:child_process';\nconst args=process.argv.slice(2);const child=spawn(${JSON.stringify(fileURLToPath(new URL('../../../packages/agent/native/codex.mjs',import.meta.url)))},args[0]==='--mote-context-budget-version'?args:[...args,'-c',${JSON.stringify('openai_base_url='+JSON.stringify(origin+'/v1'))},'-c',${JSON.stringify('model_catalog_json='+JSON.stringify(catalog))}],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));process.on('SIGTERM',()=>child.kill('SIGTERM'));\n`,{mode:0o700});
 const config:Config={dataDir:join(root,'data'),token:'generated-budget-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  modelProtocol:'codex-app-server',model:'gpt-6.1-terra',modelMaxTokens:65536,modelBaseUrl:'',apiKey:'',codexBin:executable,codexHome:root,allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 node=await buildApp(config,{backgroundWorker:false});
 t.after(async()=>{await node.app.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});});
 await node.app.ready();
 const configuration=await node.app.inject({method:'GET',url:'/api/configuration',headers}),models=node.featureServices.configService.current<ModelDomain>('models');
 const fast=await node.app.inject({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:configuration.json().revision,value:{...models,deployment:{...models.deployment,serviceTier:'fast'}}}});assert.equal(fast.statusCode,200,fast.body);
 if(window!==272000){const settings=await node.app.inject({method:'GET',url:'/api/configuration',headers});const changed=await node.app.inject({method:'PUT',url:'/api/configuration/conversations',headers,payload:{revision:settings.json().revision,value:{context:{contextWindow:window,contextWindowSource:'configured'}}}});assert.equal(changed.statusCode,200,changed.body);}
 const id=randomUUID(),text='Generated complete source. '+Array.from({length:80},(_,i)=>`Generated block ${i}. `+'证'.repeat(1000)).join('');
 const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:at,text}});assert.equal(created.statusCode,201,created.body);
 await node.materialOrganizer.tick(100);
 const initial=node.materials.list({limit:1}).items[0];
 const material=node.materials.publish({id:initial.id,kind:'mote.note',schemaVersion:1,title:'Generated complete source',origin:initial.origin,members:[{id:'original',kind:'capture',ref:'capture:'+id}],
  blocks:Array.from({length:80},(_,i)=>({id:'generated-'+i,kind:'text' as const,format:'plain',text:`Generated block ${i}. `+'证'.repeat(1000),memberIds:['original']})),
  artifacts:[{key:'body',state:'ready',blockIds:Array.from({length:80},(_,i)=>'generated-'+i)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:initial.revision});
 return {get node(){return node;},requests,material,originalId:id,setExpectedWindow(value:number){window=value;},holdCompletion(){let release!:()=>void;completionGate=new Promise<void>(done=>release=done);return release;},async restart(){
  const configuration={models:node.featureServices.configService.current<ModelDomain>('models'),conversations:node.featureServices.configService.current('conversations')};
  await node.app.close();node=await buildApp({...config,configuration} as Config,{backgroundWorker:false});await node.app.ready();
 }};
}

type Fixture=Awaited<ReturnType<typeof fixture>>;
async function wait(f:Fixture,batch:string){
 const end=Date.now()+15000;while(!['succeeded','failed','blocked','stale'].includes(f.node.batchProcessing.progress(batch).task.state)&&Date.now()<end)await new Promise(done=>setTimeout(done,10));
 return f.node.batchProcessing.progress(batch);
}
function start(f:Fixture){return f.node.featureServices.assistantFollowup.start({operationId:randomUUID(),requestId:randomUUID(),scope:{kind:'all'},materialRefs:[f.material.ref],mode:{kind:'change'}},{identities:[],connections:f.node.featureServices.availableModelConnections()});}

test('assistant follow-up with many backing originals completes through the real native provider and later original reads',async t=>{
 const f=await fixture(t),service=f.node.featureServices.assistantFollowup;
 const task=await start(f);
 const batch=service.progress(task.id).batch!.task.id;
 const progress=await wait(f,batch);assert.equal(progress.task.state,'succeeded',JSON.stringify(progress.items.map(item=>f.node.executor.failure(item.id)??{state:item.state,error:item.error})));
 assert.deepEqual((await service.finish(task.id)).cardIds,[]);
 assert.equal(f.requests.length,2,'one request and one selected original read; no replay or hidden compaction');
 const result=f.requests[1].input.findLast((item:any)=>item.type==='function_call_output');
 assert.ok(result);assert.match(JSON.stringify(result),/证/,'the later original remains readable rather than permanently omitted');
 const receipt=f.node.batchProcessing.result(batch)!.usage!,usage=receipt.tokens!;assert.equal(receipt.status,'completed');assert.equal(usage.inputTokens,200);assert.equal(usage.outputTokens,20);assert.equal(usage.totalTokens,220);assert.equal(usage.measurement,'thread_cumulative');assert.equal(usage.complete,true);
 t.diagnostic(JSON.stringify({requests:f.requests.length,window:272000,outputReserve:128000,minimumHeadroom:Math.min(...f.requests.map(body=>272000-128000-estimateSerializedTokens(body).tokens))}));
});

test('the owner HTTP retry after restart resumes a settled automatic follow-up with its existing task, batch and trigger',async t=>{
 const f=await fixture(t);let service=f.node.featureServices.assistantFollowup;
 let now=Date.now()+60001;(f.node.assistantChanges as unknown as {now:()=>number}).now=()=>now;
 f.node.modelAuthorization.command({action:'on',revision:f.node.modelAuthorization.view().revision,operationId:randomUUID()});
 f.node.assistantChanges.tick(100);now+=60001;
 const legacy=t.mock.method(service,'prepareQuery',input=>input);
 await service.tick(f.node.assistantChanges);
 const task=f.node.store.db.prepare("SELECT id FROM task_records WHERE kind='assistant.followup'").get()!;assert.ok(task);
 const batch=service.progress(String(task.id)).batch!.task.id;
 const failed=await wait(f,batch);assert.equal(failed.task.state,'failed');assert.equal(failed.items[0].error,'processing_limit');assert.equal(f.requests.length,0,'the oversized effective request never reaches the provider');
 await service.tick(f.node.assistantChanges);
 legacy.mock.restore();
 await f.restart();service=f.node.featureServices.assistantFollowup;
 const path='/api/assistant/followups/'+task.id,query=new URLSearchParams({scope:JSON.stringify({kind:'all'})});
 assert.equal((await f.node.app.inject({method:'GET',url:path+'?'+query})).statusCode,401);
 assert.equal((await f.node.app.inject({method:'GET',url:path+'?'+new URLSearchParams({scope:JSON.stringify({kind:'selection',evidenceIds:[]})}),headers})).statusCode,404);
 const before=await f.node.app.inject({method:'GET',url:path+'?'+query,headers});assert.equal(before.statusCode,200,before.body);const view=before.json();
 assert.equal(view.task.state,'blocked');assert.deepEqual(view.allowedActions,['retry']);assert.equal(view.batch.task.id,batch);
 const payload={expectedRevision:view.task.revision,scope:view.scope};
 const {invitation}=f.node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector'},'collector');
 const collector=await f.node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'}),collectorHeaders={authorization:'Bearer '+collector.token};
 assert.equal((await f.node.app.inject({method:'GET',url:path+'?'+query,headers:collectorHeaders})).statusCode,403);
 assert.equal((await f.node.app.inject({method:'POST',url:path+'/retry',headers:collectorHeaders,payload})).statusCode,403);
 assert.equal((await f.node.app.inject({method:'POST',url:path+'/retry',headers,payload:{...payload,scope:{kind:'selection',evidenceIds:[]}}})).statusCode,409);
 f.node.modelAuthorization.command({action:'off',revision:f.node.modelAuthorization.view().revision,operationId:randomUUID()});
 assert.deepEqual((await f.node.app.inject({method:'GET',url:path+'?'+query,headers})).json().allowedActions,[]);
 assert.equal((await f.node.app.inject({method:'POST',url:path+'/retry',headers,payload})).statusCode,409);
 f.node.modelAuthorization.command({action:'on',revision:f.node.modelAuthorization.view().revision,operationId:randomUUID()});
 assert.equal((await f.node.app.inject({method:'POST',url:path+'/retry',headers,payload:{...payload,expectedRevision:payload.expectedRevision-1}})).statusCode,409);
 const retried=await f.node.app.inject({method:'POST',url:path+'/retry',headers,payload});assert.equal(retried.statusCode,202,retried.body);
 assert.equal(retried.json().task.id,task.id);assert.equal(retried.json().batch.task.id,batch);
 assert.equal((await f.node.app.inject({method:'POST',url:path+'/retry',headers,payload})).statusCode,409,'a lost command response cannot reset the same retry a second time');
 assert.equal((await wait(f,batch)).task.state,'succeeded');await service.tick(f.node.assistantChanges);
 const after=await f.node.app.inject({method:'GET',url:path+'?'+query,headers});assert.equal(after.statusCode,200,after.body);assert.equal(after.json().task.state,'succeeded');assert.deepEqual(after.json().allowedActions,[]);
 assert.equal(f.node.store.db.prepare('SELECT t.state FROM assistant_change_work w JOIN task_records t ON t.id=w.task_id WHERE w.started_batch=?').get(batch)!.state,'succeeded','the settled change record resumes and completes with its saved follow-up');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,1);
 assert.equal(f.requests.length,2,'retry uses one fresh bounded native turn with no replay of prior work');
 assert.equal(failed.items[0].attempts,1);assert.equal(f.node.batchProcessing.progress(batch).items[0].attempts,1,'the existing explicit owner retry resets its bounded attempt budget');
});

test('full request packing splits automatic work below the transport ceiling and retains every trigger',async t=>{
 const f=await fixture(t,170000),service=f.node.featureServices.assistantFollowup;let now=Date.now()+60001;
 (f.node.assistantChanges as unknown as {now:()=>number}).now=()=>now;
 f.node.modelAuthorization.command({action:'on',revision:f.node.modelAuthorization.view().revision,operationId:randomUUID()});
 const notes=[];
 for(let i=0;i<5;i++){
  const id=randomUUID(),text=`Generated automatic source ${i}. `+'证'.repeat(970);
  const created=await f.node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-'+i,deviceName:'Generated',platform:'import',capturedAt:at,text}});assert.equal(created.statusCode,201,created.body);notes.push(id);
 }
 await f.node.materialOrganizer.tick(100);f.node.assistantChanges.tick(100);now+=60001;
 const refs=f.node.materials.list({limit:100}).items.filter(item=>notes.includes(item.origin.externalId)).map(item=>item.ref);assert.equal(refs.length,5);
 await assert.rejects(service.start({operationId:randomUUID(),requestId:randomUUID(),scope:{kind:'all'},materialRefs:refs,mode:{kind:'change'}},{identities:[],connections:f.node.featureServices.availableModelConnections()}),error=>{
  assert.ok(error instanceof Error&&'bytes' in error);assert.ok((error as {bytes:number}).bytes<38400,'the complete request, not the byte ceiling, requires the split');return true;
 });
 const states=()=>notes.map(id=>String(f.node.store.db.prepare('SELECT t.state FROM assistant_change_work w JOIN task_records t ON t.id=w.task_id WHERE w.capture_id=?').get(id)?.state));
 for(let i=0;i<8&&!states().every(state=>state==='succeeded');i++){
  await service.tick(f.node.assistantChanges);
  for(const row of f.node.store.db.prepare("SELECT id FROM task_records WHERE kind='assistant.followup' AND state='waiting'").all()){const batch=service.progress(String(row.id)).batch!.task.id;assert.equal((await wait(f,batch)).task.state,'succeeded');}
  await service.tick(f.node.assistantChanges);
 }
 assert.deepEqual(states(),notes.map(()=> 'succeeded'));
 assert.ok(f.requests.length>=4,'the whole group completes as multiple bounded analyses');
 for(const id of notes)assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant' AND original=?").get('capture:'+id)!.n,1);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,6,'the five new originals and the fixture original each consume their existing receipt once');
});

test('an indivisible full request stays blocked and unclaimed, then resumes after an explicit capacity correction',async t=>{
 const f=await fixture(t,132000),service=f.node.featureServices.assistantFollowup;let now=Date.now()+60001;
 (f.node.assistantChanges as unknown as {now:()=>number}).now=()=>now;
 f.node.modelAuthorization.command({action:'on',revision:f.node.modelAuthorization.view().revision,operationId:randomUUID()});
 const id=randomUUID(),created=await f.node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-unfit',deviceName:'Generated',platform:'import',capturedAt:at,text:'Generated current evidence still requires its complete context.'}});assert.equal(created.statusCode,201,created.body);
 await f.node.materialOrganizer.tick(100);f.node.assistantChanges.tick(100);now+=60001;
 await service.tick(f.node.assistantChanges);
 const state=()=>f.node.store.db.prepare('SELECT t.state,w.started_batch FROM assistant_change_work w JOIN task_records t ON t.id=w.task_id WHERE w.capture_id=?').get(id)!;
 assert.equal(state().state,'blocked');assert.equal(state().started_batch,null);assert.equal(f.requests.length,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,0);
 const settings=await f.node.app.inject({method:'GET',url:'/api/configuration',headers});
 const changed=await f.node.app.inject({method:'PUT',url:'/api/configuration/conversations',headers,payload:{revision:settings.json().revision,value:{context:{contextWindow:272000,contextWindowSource:'configured'}}}});assert.equal(changed.statusCode,200,changed.body);
 f.setExpectedWindow(272000);
 await service.tick(f.node.assistantChanges);
 const batch=String(state().started_batch);assert.notEqual(batch,'null');assert.equal((await wait(f,batch)).task.state,'succeeded');await service.tick(f.node.assistantChanges);
 assert.equal(state().state,'succeeded');assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant' AND original=?").get('capture:'+id)!.n,1);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_trigger_claims WHERE purpose='assistant'").get()!.n,2,'the blocked new original and the fixture original both resume without duplicate claims');
});

test('withdrawal after the native context read rejects the late answer and the owner retry command',async t=>{
 const f=await fixture(t),release=f.holdCompletion();
 try{
  const task=await start(f),progress=f.node.featureServices.assistantFollowup.progress(task.id).batch!,end=Date.now()+15000;
  while(f.requests.length<2&&Date.now()<end)await new Promise(done=>setTimeout(done,10));
  assert.equal(f.requests.length,2,'hold the actual provider continuation after the selected original was read');
  const deleted=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+f.originalId,headers});assert.equal(deleted.statusCode,200,deleted.body);
  release();await f.node.executor.drain(progress.items.map(item=>item.id));
  assert.equal(f.node.batchProcessing.progress(progress.task.id).task.state,'stale');
  const retry=await f.node.app.inject({method:'POST',url:`/api/assistant/followups/${task.id}/retry`,headers,payload:{expectedRevision:task.revision,scope:{kind:'all'}}});assert.equal(retry.statusCode,409);
  assert.equal(f.node.featureServices.assistantCards.page({scope:{kind:'all'}}).items.length,0);
  const rows=f.node.store.db.prepare('SELECT state,input_json,result_json FROM task_records WHERE operation_id=?').all(task.operationId);assert.ok(rows.length>=3);
  for(const row of rows){assert.equal(row.state,'stale');assert.equal(row.input_json,null);assert.equal(row.result_json,null);}
 }finally{release();}
});
