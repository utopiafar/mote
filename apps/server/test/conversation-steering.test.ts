import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {createServer} from 'node:http';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';

async function until<T>(check:()=>T|undefined|Promise<T|undefined>,label:string){const end=Date.now()+8000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated conversation steering did not settle: '+label);}
async function fixture(t:TestContext,{runtime='codex'}:{runtime?:'codex'|'dsh'}={}){
  const root=mkdtempSync(join(tmpdir(),'mote-conversation-steering-')),rpcPath=join(root,'rpc.ndjson'),executable=join(root,'generated-codex.mjs'),modePath=join(root,'mode'),routeGate=join(root,'release-route'),nativeGate=join(root,'release-native');writeFileSync(modePath,'normal');
  writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused-steering-key'}),{mode:0o600});
  writeFileSync(executable,`#!${process.execPath}
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const threadId='generated-thread-'+process.pid,turnId='generated-turn-'+process.pid;let original;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const finish=answer=>{send({method:'item/completed',params:{threadId,turnId,item:{id:'generated-answer',type:'agentMessage',text:JSON.stringify({answer,citationIds:[]})}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify({pid:process.pid,...m})+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:turnId}}});const envelope=JSON.parse(m.params.input[0].text);original=envelope.request;
  let route;try{route=JSON.parse(original);}catch{}
  if(route?.task==='mote.conversation-disposition'){
   const choice=route.message.question==='GENERATED-UNRELATED'?{kind:'independent'}:{kind:'supplement',targetMessageId:route.candidates[0].id,reply:'Generated correction accepted for the active task.'};
   if(readFileSync(${JSON.stringify(modePath)},'utf8')==='hold-route'&&route.message.question!=='GENERATED-UNRELATED'){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(routeGate)})){clearInterval(timer);finish(JSON.stringify(choice));}},10);}else finish(JSON.stringify(choice));
  }else if(original==='GENERATED-LONG-WORK'&&envelope.untrustedTaskContext?.ownerClarificationReply?.messages?.length)finish('Generated recovered adjusted answer: '+envelope.untrustedTaskContext.ownerClarificationReply.messages.at(-1).question);
  else if(original!=='GENERATED-LONG-WORK')finish('Generated independent answer: '+original);
 }else if(m.method==='turn/steer'){
  if(m.params.threadId!==threadId||m.params.expectedTurnId!==turnId||original!=='GENERATED-LONG-WORK')process.exit(5);
  const mode=readFileSync(${JSON.stringify(modePath)},'utf8');if(mode==='drop-ack')process.exit(9);
  send({id:m.id,result:{turnId}});
  if(mode==='hold-terminal'){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(nativeGate)})){clearInterval(timer);finish('Generated adjusted answer: '+m.params.input[0].text);}},10);}else finish('Generated adjusted answer: '+m.params.input[0].text);
 }
});
`,{mode:0o700});
  const requests:any[]=[];let release!:()=>void;const nativeReleased=new Promise<void>(resolve=>{release=resolve;});
  const provider=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const request=JSON.parse(body);requests.push(request);const content=request.messages.filter((message:any)=>message.role==='user').at(-1).content,envelope=JSON.parse(typeof content==='string'?content:content.find((part:any)=>part.type==='text').text),question=envelope.request;let route;try{route=JSON.parse(question);}catch{}
    if(route?.task==='mote.conversation-disposition'){writeMessagesResponse(res,{stage:0,model:'generated-steering-model',text:JSON.stringify({answer:JSON.stringify({kind:'supplement',targetMessageId:route.candidates[0].id,reply:'Generated queued continuation.'}),citationIds:[]})});return;}
    if(question==='GENERATED-LONG-WORK')await nativeReleased;if(res.destroyed)return;
    writeMessagesResponse(res,{stage:1,model:'generated-steering-model',text:JSON.stringify({answer:question==='GENERATED-LONG-WORK'?'Generated original completed answer.':'Generated continuation answer.',citationIds:[],draft:question==='GENERATED-LONG-WORK'?{goal:'Generated old task draft'}:null})});
  });await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const config:Config={dataDir:join(root,'vault'),token:'generated-steering-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated-steering-model',modelProvider:runtime==='codex'?'codex':'deepseek',modelProtocol:runtime==='codex'?'codex-app-server':'deepseek',modelBaseUrl:runtime==='codex'?'':'http://127.0.0.1:'+(provider.address() as {port:number}).port,apiKey:runtime==='codex'?'':'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',agentTimeoutMs:20000,codexBin:executable,codexHome:root};
  const open=()=>buildApp(config,{backgroundWorker:false});
  let node=await open();t.after(async()=>{release();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(root,{recursive:true,force:true});});const headers={authorization:'Bearer '+config.token};
  const id=(await node.app.inject({url:'/api/conversations/main',headers})).json().id as string;
  const rpc=()=>{try{return readFileSync(rpcPath,'utf8').trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));}catch{return [];}};
  const post=async(question:string,clientRequestId=randomUUID(),scope:Record<string,unknown>={kind:'all'},extra:Record<string,unknown>={})=>{const payload={conversationId:id,clientRequestId,question,scope,...extra},response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(response.statusCode,202,response.body);return {message:response.json(),payload};};
  const settled=async(messageId:string)=>until(async()=>{const response=await node.app.inject({url:'/api/conversations/'+id+'/messages/'+messageId,headers});assert.equal(response.statusCode,200,response.body);const message=response.json();return ['completed','failed','cancelled'].includes(message.status)?message:undefined;},'message '+messageId);
  const started=async(messageId:string)=>until(()=>{const message=node.conversations.message(messageId);if(message.status==='failed')assert.fail(JSON.stringify({message,run:message.runId&&node.queryRuns.get(message.runId)}));return runtime==='codex'?rpc().find(row=>row.method==='turn/start'):requests[0];},'first native turn');
  return {root,id,headers,rpc,post,settled,started,requests,setMode:(mode:string)=>writeFileSync(modePath,mode),releaseRoute:()=>writeFileSync(routeGate,''),releaseNative:()=>{writeFileSync(nativeGate,'');release();},get node(){return node;},async restart(){await node.app.close();node=await open();}};
}

test('owner HTTP persists a correction and the chosen Codex runtime steers the same valid native turn exactly once',{timeout:30000},async t=>{
  const f=await fixture(t),first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);
  const clientRequestId=randomUUID(),second=await f.post('GENERATED-OWNER-CORRECTION',clientRequestId);assert.ok(f.node.conversations.message(second.message.id));
  await until(()=>f.rpc().find(row=>row.method==='turn/steer'),'native steering delivery');const repeated=await f.post('GENERATED-OWNER-CORRECTION',clientRequestId);assert.equal(repeated.message.id,second.message.id);
  assert.equal((await f.settled(first.message.id)).status,'completed');const applied=await f.settled(second.message.id);assert.equal(applied.status,'completed',JSON.stringify(applied));assert.equal(applied.steering.state,'accepted');assert.equal(applied.steering.targetMessageId,first.message.id);
  const original=f.node.conversations.message(first.message.id);assert.match(original.result!.answer,/GENERATED-OWNER-CORRECTION/);assert.ok(original.amendedBy?.includes(second.message.id));
  const rpc=f.rpc(),delivery=rpc.filter(row=>row.method==='turn/steer');assert.equal(delivery.length,1);assert.equal(rpc.filter(row=>row.method==='turn/start'&&row.pid===delivery[0].pid).length,1,'the correction stays in the original native turn');
});

test('an independent owner message answers while another task remains in flight without taking the conversation lock',{timeout:30000},async t=>{
  const f=await fixture(t),first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);const independent=await f.post('GENERATED-UNRELATED');
  assert.equal((await f.settled(independent.message.id)).status,'completed');assert.equal(f.node.conversations.message(first.message.id).status,'running');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);
  const response=await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.id+'/messages/'+first.message.id+'/cancel',headers:f.headers});assert.equal(response.statusCode,200,response.body);
});

test('actual SQLite accepted-receipt failure after native ACK persists unknown delivery, rejects the old output and never resends on restart',{timeout:30000},async t=>{
  const f=await fixture(t),first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);
  f.node.store.db.exec("CREATE TRIGGER generated_steering_ack_failure BEFORE UPDATE ON conversation_turns WHEN json_extract(NEW.json,'$.steering.state')='accepted' BEGIN SELECT RAISE(ABORT,'generated accepted receipt write failure'); END");
  const second=await f.post('GENERATED-OWNER-CORRECTION');await until(()=>f.rpc().find(row=>row.method==='turn/steer'),'actual steering ACK');assert.equal((await f.settled(first.message.id)).status,'failed');const unknown=await f.settled(second.message.id);assert.equal(unknown.status,'failed');assert.equal(unknown.steering.state,'unknown');assert.equal(f.node.conversations.message(first.message.id).result,undefined);
  f.node.store.db.exec('DROP TRIGGER generated_steering_ack_failure');await f.restart();const repeated=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:f.headers,payload:second.payload});assert.equal(repeated.statusCode,202,repeated.body);assert.equal(repeated.json().id,second.message.id);assert.equal(repeated.json().steering.state,'unknown');
  const independent=await f.post('GENERATED-UNRELATED');assert.equal((await f.settled(independent.message.id)).status,'completed');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);assert.deepEqual(f.node.conversations.message(first.message.id).scope,{kind:'all'});
});

test('unsupported DSH steering persists a continuation through restart and consumes the completed target under a fresh authorized query',{timeout:30000},async t=>{
  const f=await fixture(t,{runtime:'dsh'}),first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);const second=await f.post('GENERATED-OWNER-CORRECTION');
  await until(()=>f.node.conversations.message(second.message.id).steering?.state==='continuation','durable unsupported continuation');assert.equal(f.requests.length,2,'one active request and one semantic disposition, with no replacement prompt yet');
  assert.equal(f.node.conversations.message(first.message.id).status,'running');await f.restart();
  await until(()=>f.requests.length>=3,'the existing interrupted read-only target to resume');f.releaseNative();assert.equal((await f.settled(first.message.id)).status,'completed');const continued=await f.settled(second.message.id);assert.equal(continued.status,'completed',JSON.stringify({continued,run:f.node.queryRuns.get(second.message.id)}));assert.equal(continued.steering.state,'continuation');
  const current=f.node.conversations.message(second.message.id);assert.equal(current.runId,second.message.id);assert.equal(current.result!.answer,'Generated continuation answer.');assert.match(JSON.stringify(f.requests.at(-1)),/Generated original completed answer/);assert.match(JSON.stringify(f.requests.at(-1)),/GENERATED-OWNER-CORRECTION/);
  const target=f.node.conversations.message(first.message.id);assert.ok(target.supersededBy?.includes(second.message.id));assert.ok(target.result!.draft);
  const draft=target.result!.draft!,command=await f.node.app.inject({method:'POST',url:'/api/assistant/commands',headers:f.headers,payload:{conversationId:f.id,turnId:target.id,requestId:draft.requestId,expectedRevision:draft.revision,goal:draft.goal,scope:draft.scope,capability:'assistant.task.preview'}});assert.equal(command.statusCode,409,command.body);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);
});

test('cancelling an unsupported pending continuation leaves the original task valid and does not apply or retry the cancelled message',{timeout:30000},async t=>{
  const f=await fixture(t,{runtime:'dsh'}),first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);const second=await f.post('GENERATED-OWNER-CORRECTION');await until(()=>f.node.conversations.message(second.message.id).steering?.state==='continuation','queued continuation');
  const response=await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.id+'/messages/'+second.message.id+'/cancel',headers:f.headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status,'cancelled');assert.ok(!f.node.conversations.message(first.message.id).supersededBy?.includes(second.message.id));
  f.releaseNative();assert.equal((await f.settled(first.message.id)).status,'completed');assert.equal(f.node.conversations.message(second.message.id).result,undefined);assert.equal(f.requests.length,2);await f.restart();assert.equal(f.node.conversations.message(second.message.id).status,'cancelled');assert.equal(f.requests.length,2);
});

test('cancelling an already acknowledged correction cancels the affected active task without claiming the native input was recalled',{timeout:30000},async t=>{
  const f=await fixture(t);f.setMode('hold-terminal');const first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);const second=await f.post('GENERATED-OWNER-CORRECTION');const applied=await f.settled(second.message.id);assert.equal(applied.steering.state,'accepted');assert.equal(f.node.conversations.message(first.message.id).status,'running');
  const response=await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.id+'/messages/'+second.message.id+'/cancel',headers:f.headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().steering.state,'cancelled');f.releaseNative();assert.equal((await f.settled(first.message.id)).status,'cancelled');assert.equal(f.node.conversations.message(first.message.id).result,undefined);assert.equal(f.node.conversations.message(second.message.id).result,undefined);
  await f.restart();assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);const next=await f.post('GENERATED-UNRELATED');assert.equal((await f.settled(next.message.id)).status,'completed');assert.equal(f.node.conversations.get(f.id).turns.length,3);
});

test('an acknowledged amendment survives Central restart as controlled prepared input without replaying native steering or losing the owner correction',{timeout:30000},async t=>{
  const f=await fixture(t);f.setMode('hold-terminal');const first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);const second=await f.post('GENERATED-OWNER-CORRECTION');assert.equal((await f.settled(second.message.id)).steering.state,'accepted');assert.equal(f.node.conversations.message(first.message.id).status,'running');
  await f.restart();const completed=await f.settled(first.message.id);assert.equal(completed.status,'completed',JSON.stringify({completed,run:f.node.queryRuns.get(first.message.id)}));
  const original=f.node.conversations.message(first.message.id);assert.equal(original.question,'GENERATED-LONG-WORK');assert.equal(original.runId,first.message.id);assert.match(original.result!.answer,/Generated recovered adjusted answer: GENERATED-OWNER-CORRECTION/);assert.deepEqual(original.scope,{kind:'all'});
  const rpc=f.rpc();assert.equal(rpc.filter(row=>row.method==='turn/steer').length,1);assert.equal(rpc.filter(row=>row.method==='turn/start').length,3);const recovered=rpc.filter(row=>row.method==='turn/start').at(-1),envelope=JSON.parse(recovered.params.input[0].text);assert.deepEqual(envelope.untrustedTaskContext.ownerClarificationReply.messages,[{messageId:second.message.id,question:'GENERATED-OWNER-CORRECTION'}]);assert.equal(f.node.conversations.get(f.id).turns.length,2);
  const firstPid=rpc.find(row=>row.method==='turn/start').pid,initialTools=rpc.find(row=>row.method==='thread/start'&&row.pid===firstPid).params.dynamicTools,recoveredTools=rpc.find(row=>row.method==='thread/start'&&row.pid===recovered.pid).params.dynamicTools;assert.deepEqual(recoveredTools,initialTools,'recovery adds no history/search or other runtime tool');assert.equal(envelope.conversation,undefined,'later conversation bodies are not injected while restoring the original task');
});

test('current original withdrawal rejects in-flight disposition and its old task while a fresh empty-scope message remains independent',{timeout:30000},async t=>{
  const f=await fixture(t);f.setMode('hold-route');const id=randomUUID(),text='GENERATED-PRIVATE-ORIGINAL-STEERING-CONTENT';
  const intake=await f.node.app.inject({method:'POST',url:'/api/captures',headers:f.headers,payload:{id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:text}});assert.equal(intake.statusCode,201,intake.body);
  const scope={kind:'selection',evidenceIds:[id]},first=await f.post('GENERATED-LONG-WORK',randomUUID(),scope);await f.started(first.message.id);const second=await f.post('GENERATED-OWNER-CORRECTION',randomUUID(),scope);await until(()=>f.rpc().filter(row=>row.method==='turn/start').length===2,'the scoped disposition to start');
  assert.equal((await f.node.app.inject({method:'DELETE',url:'/api/captures/'+id,headers:f.headers})).statusCode,200);f.releaseRoute();assert.equal((await f.settled(second.message.id)).status,'failed');assert.equal((await f.settled(first.message.id)).status,'failed');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);
  const third=await f.post('GENERATED-UNRELATED',randomUUID(),{kind:'selection',evidenceIds:[]});assert.equal((await f.settled(third.message.id)).status,'completed');assert.doesNotMatch(f.rpc().filter(row=>row.method==='turn/start').at(-1).params.input[0].text,new RegExp(text));
  const history=await f.node.app.inject({url:'/api/conversations/'+f.id,headers:f.headers});assert.equal(history.statusCode,200,history.body);assert.doesNotMatch(history.body,/"disposition"|"registrationId"|"attemptId"/);assert.deepEqual(f.node.conversations.message(first.message.id).scope,scope);
});

test('an unknown native steering ACK remains unknown across restart and cannot be resent by a duplicate owner request',{timeout:30000},async t=>{
  const f=await fixture(t);f.setMode('drop-ack');const first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);const second=await f.post('GENERATED-OWNER-CORRECTION');assert.equal((await f.settled(second.message.id)).steering.state,'unknown');assert.equal((await f.settled(first.message.id)).status,'failed');
  await f.restart();const replay=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:f.headers,payload:second.payload});assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().steering.state,'unknown');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);const next=await f.post('GENERATED-UNRELATED');assert.equal((await f.settled(next.message.id)).status,'completed');
});

for(const restriction of ['scope','model'] as const)test(`a new owner ${restriction} selection cannot disclose or steer an incompatible active task`,{timeout:30000},async t=>{
  const f=await fixture(t),first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);
  const second=await f.post('GENERATED-OWNER-CORRECTION',randomUUID(),restriction==='scope'?{kind:'selection',evidenceIds:[]}:{kind:'all'},restriction==='model'?{modelOverride:'generated-other-model'}:{});assert.equal((await f.settled(second.message.id)).status,'completed');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);assert.equal(f.rpc().filter(row=>row.method==='turn/start').length,2,'no eligible target means no classification model call');
  const native=f.rpc().filter(row=>row.method==='turn/start').at(-1);assert.doesNotMatch(native.params.input[0].text,/GENERATED-LONG-WORK/);assert.deepEqual(f.node.conversations.message(first.message.id).scope,{kind:'all'});
  const response=await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.id+'/messages/'+first.message.id+'/cancel',headers:f.headers});assert.equal(response.statusCode,200,response.body);
});

test('a late disposition for a cancelled target never steers a replacement task with the same goal',{timeout:30000},async t=>{
  const f=await fixture(t);f.setMode('hold-route');const first=await f.post('GENERATED-LONG-WORK');await f.started(first.message.id);const second=await f.post('GENERATED-OWNER-CORRECTION');await until(()=>f.rpc().filter(row=>row.method==='turn/start').length===2,'held disposition');
  assert.equal((await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.id+'/messages/'+first.message.id+'/cancel',headers:f.headers})).statusCode,200);
  const replacement=await f.post('GENERATED-LONG-WORK');await until(()=>f.rpc().filter(row=>row.method==='turn/start').length===3,'new target identity');f.releaseRoute();const refused=await f.settled(second.message.id);assert.equal(refused.status,'failed');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);assert.equal(f.node.conversations.message(replacement.message.id).status,'running');assert.notEqual(first.message.id,replacement.message.id);
  assert.equal((await f.node.app.inject({method:'POST',url:'/api/conversations/'+f.id+'/messages/'+replacement.message.id+'/cancel',headers:f.headers})).statusCode,200);
});
