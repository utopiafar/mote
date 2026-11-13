import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {assistantTaskRecordSchema} from '@mote/shared';
import {TaskRecords} from '../src/task-records.js';
import type {MatterAuthority} from '../src/assistant-matters.js';

const token='generated-task-journey-owner',headers={authorization:'Bearer '+token};
const text='GENERATED BLUE ORCHID FILE EVIDENCE';
async function until(check:()=>boolean){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for generated task');}

async function fixture(t:TestContext,productionGuard=false){
 const directory=mkdtempSync(join(tmpdir(),'mote-task-journey-'));
 let evidenceId='',wire='',taskCalls=0,hold=false,release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const provider=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  const parsed=JSON.parse(body),messages=parsed.messages as {role:string;content?:unknown}[];
  const isTask=JSON.stringify(messages).includes('Generated task goal');
  let delta:unknown,finish='stop';
  if(!isTask)delta={role:'assistant',content:JSON.stringify({answer:'Generated initial answer',citationIds:[],draft:{goal:'Generated task goal'}})};
  else if(!messages.some(message=>message.role==='tool')){
   taskCalls++;delta={role:'assistant',tool_calls:[{index:0,id:'generated-file-read',type:'function',function:{name:'evidence',arguments:JSON.stringify({ids:[evidenceId]})}}]};finish='tool_calls';
  }else{
   wire=body;if(hold){entered();await held;}
   delta={role:'assistant',content:JSON.stringify({answer:'Generated grounded answer',citationIds:[evidenceId]})};
  }
  if(res.destroyed)return;res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  send({id:'generated-task',choices:[{index:0,delta,finish_reason:null}]});
  send({id:'generated-task',choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,dataKey:'64'.repeat(32),contentEncryptionEnabled:true,token,tokenPath:'fixture',host:'127.0.0.1',port:0,
  maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',
  modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512,apiKey:'generated-only',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 const build=async()=>{
  const node=await buildApp(config,{backgroundWorker:false});
  // This fixture supplies a deliberately small controlled provider. Production's
  // complete-request budget guard remains installed and is tested separately.
  if(!productionGuard)(node.batchProcessing as unknown as {modelAdmission:()=>undefined}).modelAdmission=()=>undefined;
  await node.app.ready();return node;
 };
 let node=await build();
 t.after(async()=>{release();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const note=async(label:string)=>{const id=randomUUID(),r=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:label}});assert.equal(r.statusCode,201,r.body);return id;};
 const upload=async()=>{
  const source=await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'archive'}});assert.equal(source.statusCode,200,source.body);
  const bytes=Buffer.from(text),manifest={sourceId:'generated-files',item:{externalId:'generated.txt',revision:'1',observedAt:new Date().toISOString(),title:'Generated.txt',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)};
  const begun=await node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:manifest});assert.equal(begun.statusCode,200,begun.body);
  const id=begun.json().uploadId;
  const part=await node.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${id}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(part.statusCode,200,part.body);
  const saved=await node.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${id}/commit`,headers,payload:{}});assert.equal(saved.statusCode,200,saved.body);
  const fileId=saved.json().id,initial=node.processing.view(),settings={...initial.settings,enabled:true,summarize:false};
  await node.processing.save({revision:initial.revision,settings,policy:fixtureFilePolicy(settings,node.processing.runtime.registry)});
  await node.processing.tick();
  const chunks=node.files.chunks(fileId);assert.ok(chunks.some(chunk=>chunk.ocrText.includes(text)),'the uploaded file was actually extracted');
  const page=node.featureServices.evidenceReader.queryPage({limit:100},'browse');
  evidenceId=page.items.find(record=>record.ocrText.includes(text))?.id??chunks.find(chunk=>chunk.ocrText.includes(text))!.id;
  return fileId;
 };
 const draft=async(evidenceIds?:string[])=>{
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated initial question',...(evidenceIds?{evidenceIds}:{})}});assert.equal(response.statusCode,200,response.body);
  const value=response.json();assert.ok(value.draft);return value;
 };
 const command=(value:any)=>({conversationId:value.conversationId,turnId:value.turnId,requestId:value.draft.requestId,expectedRevision:value.draft.revision,capability:'assistant.task.start',goal:value.draft.goal,scope:value.draft.scope});
 const start=async(value:any)=>{const result=await node.app.inject({method:'POST',url:'/api/assistant/commands',headers,payload:command(value)});assert.equal(result.statusCode,200,result.body);return result.json();};
 const read=async(value:any)=>{const params=new URLSearchParams({scope:JSON.stringify(value.draft.scope)}),response=await node.app.inject({url:`/api/conversations/${value.conversationId}/messages/${value.turnId}/assistant-tasks?${params}`,headers});assert.equal(response.statusCode,200,response.body);return response.json().items;};
 return {get node(){return node;},get wire(){return wire;},get evidenceId(){return evidenceId;},get taskCalls(){return taskCalls;},note,upload,draft,start,read,started,release,setHold(value:boolean){hold=value;},setEvidence(id:string){evidenceId=id;},async restart(){await node.app.close();node=await build();}};
}

test('an uploaded file is read through the real draft command and its result survives restart; new all-scope data retires it',async t=>{
 const f=await fixture(t),fileId=await f.upload(),turn=await f.draft();
 const first=await f.start(turn),again=await f.start(turn);assert.equal(first.taskId,again.taskId);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(first.taskId)?.state==='succeeded');
 assert.match(f.wire,new RegExp(text));
 const [before]=await f.read(turn);assert.equal(before.task.id,first.taskId);assert.equal(before.task.state,'completed');
 assert.equal(assistantTaskRecordSchema.parse(before.task).goal,'Generated task goal');
 assert.equal(before.result.answer,'Generated grounded answer');assert.deepEqual(before.result.citations.map((item:any)=>item.id),[f.evidenceId]);
 const hiddenPath=`/api/conversations/${turn.conversationId}/messages/${turn.turnId}/assistant-tasks?`+new URLSearchParams({scope:JSON.stringify({kind:'selection',evidenceIds:[]})});
 const hidden=await f.node.app.inject({url:hiddenPath,headers});assert.equal(hidden.statusCode,200);assert.deepEqual(hidden.json(),{items:[]});
 const {invitation}=f.node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector'},'collector');
 const collector=await f.node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'});
 const originalPath=`/api/conversations/${turn.conversationId}/messages/${turn.turnId}/assistant-tasks?`+new URLSearchParams({scope:JSON.stringify(turn.draft.scope)});
 assert.equal((await f.node.app.inject({url:originalPath})).statusCode,401);
 assert.equal((await f.node.app.inject({url:originalPath,headers:{authorization:'Bearer '+collector.token}})).statusCode,403);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get().n,1);
 assert.ok(f.node.store.db.prepare('SELECT 1 FROM task_evidence WHERE task_id=? AND evidence_id=?').get(first.taskId,fileId),'file origin is retained in result lineage');
 await f.restart();const [recovered]=await f.read(turn);assert.equal(recovered.result.answer,before.result.answer);assert.equal(recovered.task.id,first.taskId);
 await f.note('Generated newly arrived original');const [stale]=await f.read(turn);assert.equal(stale.task.state,'stale');assert.equal(stale.result,undefined);
 const erased=f.node.store.db.prepare('SELECT input_json,result_json FROM task_records WHERE id=?').get(first.taskId)!;assert.equal(erased.input_json,null);assert.equal(erased.result_json,null);
 const old=await f.node.app.inject({method:'POST',url:'/api/assistant/commands',headers,payload:{conversationId:turn.conversationId,turnId:turn.turnId,requestId:turn.draft.requestId,expectedRevision:1,capability:'assistant.task.start',goal:turn.draft.goal,scope:turn.draft.scope}});assert.equal(old.statusCode,409);
 const fileView=f.node.featureServices.evidenceReader.queryPage({limit:100},'browse').items.find(item=>item.ocrText.includes(text));
 f.setEvidence(fileView?.id??f.node.files.chunks(fileId).find(item=>item.ocrText.includes(text))!.id);
 const fresh=await f.node.app.inject({method:'POST',url:'/api/assistant/commands',headers,payload:{conversationId:turn.conversationId,turnId:turn.turnId,requestId:randomUUID(),expectedRevision:2,capability:'assistant.task.start',goal:'Generated task goal revised',scope:turn.draft.scope}});
 assert.equal(fresh.statusCode,200,fresh.body);assert.notEqual(fresh.json().taskId,first.taskId);
 await until(()=>['succeeded','failed','blocked','stale'].includes(String(f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(fresh.json().taskId)?.state)));
 assert.equal(f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(fresh.json().taskId)?.state,'succeeded',JSON.stringify(await f.read(turn)));
 const updated=await f.read(turn);assert.equal(updated[0].task.state,'stale');assert.equal(updated[1].task.state,'completed');
});

test('no available evidence reports a real gap and sends no task model request',async t=>{
 const f=await fixture(t);const turn=await f.draft(),started=await f.start(turn);
 const [view]=await f.read(turn);assert.equal(view.task.id,started.taskId);assert.equal(view.task.state,'needs_input');assert.equal(assistantTaskRecordSchema.parse(view.task).state,'needs_input');assert.equal(view.error,'no_usable_evidence');assert.equal(view.result,undefined);assert.equal(f.taskCalls,0);
});

test('a reference-only file remains metadata and is not sent as readable task content',async t=>{
 const f=await fixture(t);
 const source=await f.node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'generated-reference',name:'Generated reference',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'reference'}});assert.equal(source.statusCode,200,source.body);
 const revision=await f.node.app.inject({method:'PUT',url:'/api/file-sync/v1/revisions',headers,payload:{sourceId:'generated-reference',relativePath:'generated.txt',
  item:{externalId:'generated.txt',revision:'1',observedAt:'2026-11-01T00:00:00Z',title:'Generated reference',kind:'file',layer:'reference',text:'',mimeType:'text/plain',deleted:false},sizeBytes:123}});
 assert.equal(revision.statusCode,200,revision.body);assert.equal(f.node.files.detail(revision.json().id).hasOriginal,false);
 const turn=await f.draft(),started=await f.start(turn),[view]=await f.read(turn);
 assert.equal(view.task.id,started.taskId);assert.equal(view.error,'no_usable_evidence');assert.equal(view.result,undefined);assert.equal(f.taskCalls,0);
});

test('an explicit empty selection stays empty even when other evidence is available',async t=>{
 const f=await fixture(t);await f.note('GENERATED OUTSIDE EMPTY SELECTION');
 const main=await f.node.app.inject({url:'/api/conversations/main',headers});assert.equal(main.statusCode,200,main.body);
 const conversationId=main.json().id;
 const accepted=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId,clientRequestId:randomUUID(),question:'Generated initial question',scope:{kind:'selection',evidenceIds:[]}}});assert.equal(accepted.statusCode,202,accepted.body);
 const turnId=accepted.json().id;
 await until(()=>f.node.conversations.message(turnId).status==='completed');
 const saved=await f.node.app.inject({url:'/api/conversations/'+conversationId,headers});assert.equal(saved.statusCode,200,saved.body);
 const turn=saved.json().turns.find((item:any)=>item.id===turnId);assert.deepEqual(turn.result.draft.scope,{kind:'selection',evidenceIds:[]});
 const value={conversationId,turnId,draft:turn.result.draft},started=await f.start(value),[view]=await f.read(value);
 assert.equal(view.task.id,started.taskId);assert.equal(view.error,'no_usable_evidence');assert.equal(view.result,undefined);assert.equal(f.taskCalls,0);
});

test('a failed draft enqueue rolls back its task and turn link before the same command is retried',async t=>{
 const f=await fixture(t),id=await f.note('Generated rollback evidence');f.setEvidence(id);const turn=await f.draft();
 const payload={conversationId:turn.conversationId,turnId:turn.turnId,requestId:turn.draft.requestId,expectedRevision:turn.draft.revision,capability:'assistant.task.start',goal:turn.draft.goal,scope:turn.draft.scope};
 const submit=t.mock.method(f.node.batchProcessing,'submit',()=>{throw Error('Generated enqueue failure');});
 const failed=await f.node.app.inject({method:'POST',url:'/api/assistant/commands',headers,payload});assert.equal(failed.statusCode,500,failed.body);
 for(const table of ['task_records','assistant_task_turns','assistant_task_scopes'])assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table+' must roll back');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='batch.item'").get().n,0);
 submit.mock.restore();const retried=await f.start(turn);await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(retried.taskId)?.state==='succeeded');
 assert.equal((await f.start(turn)).taskId,retried.taskId);
});

test('the assembled product preserves its production model-budget admission guard',async t=>{
 const f=await fixture(t,true);await f.note('Generated available evidence');const turn=await f.draft(),started=await f.start(turn);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(started.taskId)?.state==='blocked');
 const [view]=await f.read(turn);assert.equal(view.error,'model_context_budget_unavailable');assert.equal(view.result,undefined);assert.equal(f.taskCalls,0);
});

test('a selected file excludes unrelated sources and only its withdrawal retires the result',async t=>{
 const f=await fixture(t),fileId=await f.upload();await f.note('GENERATED PRIVATE OUTSIDE SOURCE');
 const turn=await f.draft([fileId]),started=await f.start(turn);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(started.taskId)?.state==='succeeded');
 assert.match(f.wire,new RegExp(text));assert.doesNotMatch(f.wire,/GENERATED PRIVATE OUTSIDE SOURCE/);
 await f.note('GENERATED LATER OUTSIDE SOURCE');const [current]=await f.read(turn);assert.equal(current.task.state,'completed');assert.equal(current.result.citations[0].id,f.evidenceId);
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/files/'+fileId,headers});assert.equal(removed.statusCode,200,removed.body);
 const [stale]=await f.read(turn);assert.equal(stale.task.state,'stale');assert.equal(stale.result,undefined);
});

test('an interrupted task resumes its original queue entry after a server restart',async t=>{
 const f=await fixture(t);await f.upload();const turn=await f.draft();f.setHold(true);const started=await f.start(turn);
 await Promise.race([f.started,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Timed out waiting for provider')),10000);timer.unref();})]);
 await f.node.app.close();f.setHold(false);f.release();await f.restart();
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(started.taskId)?.state==='succeeded');
 const [resumed]=await f.read(turn);assert.equal(resumed.task.id,started.taskId);assert.equal(resumed.result.answer,'Generated grounded answer');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get().n,1);
 assert.equal(f.taskCalls,2,'only the interrupted work is retried');
});

test('withdrawal and new in-scope data reject late task results',async t=>{
 const f=await fixture(t),fileId=await f.upload(),turn=await f.draft();f.setHold(true);const started=await f.start(turn);
 await Promise.race([f.started,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Timed out waiting for provider')),10000);timer.unref();})]);
 await f.note('Generated newer original');f.release();
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(started.taskId)?.state==='stale');
 const [view]=await f.read(turn);assert.equal(view.result,undefined);
 const work=f.node.store.db.prepare('SELECT input_json,result_json,state FROM task_records WHERE operation_id=?').all('assistant.task:'+turn.draft.requestId);
 assert.ok(work.every(row=>row.state==='stale'&&row.input_json===null&&row.result_json===null));
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/files/'+fileId,headers});assert.equal(removed.statusCode,200,removed.body);
});

test('withdrawing a selected file while the provider is in flight prevents a late result',async t=>{
 const f=await fixture(t),fileId=await f.upload(),turn=await f.draft([fileId]);f.setHold(true);const started=await f.start(turn);
 await Promise.race([f.started,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Timed out waiting for provider')),10000);timer.unref();})]);
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/files/'+fileId,headers});assert.equal(removed.statusCode,200,removed.body);
 f.release();const step=f.node.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind='batch.item'").get('assistant.task:'+turn.draft.requestId)!;
 await until(()=>!f.node.executor.isActiveStep(String(step.id)));
 const [view]=await f.read(turn);assert.equal(view.task.state,'stale');assert.equal(view.result,undefined);
 const work=f.node.store.db.prepare('SELECT input_json,result_json,state FROM task_records WHERE operation_id=?').all('assistant.task:'+turn.draft.requestId);
 assert.ok(work.every(row=>row.state==='stale'&&row.input_json===null&&row.result_json===null));
});

test('an accepted suggestion links its real result to its matter, and withdrawal erases it',async t=>{
 const f=await fixture(t),original=await f.note('Generated matter evidence');f.setEvidence(original);
 const scope={kind:'all' as const},tasks=new TaskRecords(f.node.store);
 const authority:MatterAuthority={currentEvidence:ids=>ids.flatMap(id=>{const item=f.node.store.evidence([id])[0];return item?[{id,title:item.windowTitle??'',deviceId:item.deviceId,sourceId:item.provenance?.sourceId,at:item.capturedAt}]:[];}),
  currentTask:id=>{try{const task=tasks.get(id);return {id,state:task.state,revision:task.revision,updatedAt:task.updatedAt};}catch{return undefined;}}};
 const matter=f.node.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated matter goal',scope,evidenceIds:[original]},authority);
 const cardId=randomUUID(),cards=f.node.featureServices.assistantCards;
 const card=cards.publish({id:cardId,kind:'suggestion',matterId:matter.id,version:'v1',state:'open',title:'Generated suggestion',body:'Generated suggestion',
  evidence:[{id:original,quote:'Generated matter evidence'}],evidenceDependencies:{version:1,complete:true,ids:[original]}},undefined,scope,()=>{});
 const request={requestId:randomUUID(),goal:'Generated task goal',scope},ref={cardId,expectedRevision:card.revision};
 const started=f.node.assistantTasks.acceptSuggestion(request,ref,authority);
 assert.equal(f.node.assistantTasks.acceptSuggestion(request,ref,authority).id,started.id);
 assert.deepEqual(f.node.featureServices.assistantMatters.get(matter.id).taskIds,[started.id]);
 await until(()=>tasks.get(started.id).state==='succeeded');
 const path='/api/assistant/tasks/'+started.id+'?'+new URLSearchParams({scope:JSON.stringify(scope)});
 const response=await f.node.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().result.answer,'Generated grounded answer');assert.equal(response.json().result.citations[0].id,original);
 const restricted=await f.node.app.inject({url:'/api/assistant/tasks/'+started.id+'?'+new URLSearchParams({scope:JSON.stringify({kind:'selection',evidenceIds:[]})}),headers});assert.equal(restricted.statusCode,404);
 const deleted=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+original,headers});assert.equal(deleted.statusCode,200,deleted.body);
 const expired=await f.node.app.inject({url:path,headers});assert.equal(expired.statusCode,200,expired.body);assert.equal(expired.json().task.state,'stale');assert.equal(expired.json().result,undefined);
 assert.equal(f.node.store.db.prepare('SELECT snapshot_json FROM assistant_task_scopes WHERE task_id=?').get(started.id)!.snapshot_json,null);
 const record=f.node.store.db.prepare('SELECT input_json,result_json FROM task_records WHERE id=?').get(started.id)!;assert.equal(record.input_json,null);assert.equal(record.result_json,null);
 assert.equal(f.node.featureServices.assistantMatters.detail(matter.id,authority).linkedTasks[0].state,'stale');
});
