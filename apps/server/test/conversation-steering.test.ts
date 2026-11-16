import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

async function until<T>(check:()=>T|undefined|Promise<T|undefined>,label:string){const end=Date.now()+8000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated conversation steering did not settle: '+label);}
async function fixture(t:TestContext){
  const root=mkdtempSync(join(tmpdir(),'mote-conversation-steering-')),rpcPath=join(root,'rpc.ndjson'),executable=join(root,'generated-codex.mjs');
  writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused-steering-key'}),{mode:0o600});
  writeFileSync(executable,`#!${process.execPath}
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';import {appendFileSync} from 'node:fs';
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
   const choice=route.message.question==='GENERATED-UNRELATED'?{kind:'independent'}:{kind:'supplement',targetMessageId:route.candidates[0].id,reply:'Generated correction accepted for the active task.'};finish(JSON.stringify(choice));
  }else if(original!=='GENERATED-LONG-WORK')finish('Generated independent answer: '+original);
 }else if(m.method==='turn/steer'){
  if(m.params.threadId!==threadId||m.params.expectedTurnId!==turnId||original!=='GENERATED-LONG-WORK')process.exit(5);
  send({id:m.id,result:{turnId}});finish('Generated adjusted answer: '+m.params.input[0].text);
 }
});
`,{mode:0o700});
  const config:Config={dataDir:join(root,'vault'),token:'generated-steering-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated-steering-model',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',agentTimeoutMs:20000,codexBin:executable,codexHome:root};
  let node=await buildApp(config,{backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(root,{recursive:true,force:true});});const headers={authorization:'Bearer '+config.token};
  const id=(await node.app.inject({url:'/api/conversations/main',headers})).json().id as string;
  const rpc=()=>{try{return readFileSync(rpcPath,'utf8').trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));}catch{return [];}};
  const post=async(question:string,clientRequestId=randomUUID(),scope:Record<string,unknown>={kind:'all'})=>{const payload={conversationId:id,clientRequestId,question,scope},response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(response.statusCode,202,response.body);return {message:response.json(),payload};};
  const settled=async(messageId:string)=>until(async()=>{const response=await node.app.inject({url:'/api/conversations/'+id+'/messages/'+messageId,headers});assert.equal(response.statusCode,200,response.body);const message=response.json();return ['completed','failed','cancelled'].includes(message.status)?message:undefined;},'message '+messageId);
  const started=async(messageId:string)=>until(()=>{const message=node.conversations.message(messageId);if(message.status==='failed')assert.fail(JSON.stringify({message,run:message.runId&&node.queryRuns.get(message.runId)}));return rpc().find(row=>row.method==='turn/start');},'first native turn');
  return {root,id,headers,rpc,post,settled,started,get node(){return node;},async restart(){await node.app.close();node=await buildApp(config,{backgroundWorker:false});}};
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
