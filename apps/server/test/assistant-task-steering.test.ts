import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

async function until<T>(read:()=>T|undefined|Promise<T|undefined>,label:string){const end=Date.now()+8000;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated formal task did not settle: '+label);}
async function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'mote-assistant-task-steering-')),rpcPath=join(root,'rpc.ndjson'),executable=join(root,'generated-codex'),entered=join(root,'task-entered'),gate=join(root,'release-task'),modePath=join(root,'mode'),evidencePath=join(root,'evidence-id');
 writeFileSync(modePath,'normal');writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-task-steering-key'}),{mode:0o600});
 writeFileSync(executable,`#!${process.execPath}
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const threadId='generated-task-thread-'+process.pid,turnId='generated-task-turn-'+process.pid;let envelope,isTask=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const finish=(answer,draft)=>{send({method:'item/completed',params:{threadId,turnId,item:{id:'generated-task-answer',type:'agentMessage',text:JSON.stringify({answer,citationIds:isTask?[readFileSync(${JSON.stringify(evidencePath)},'utf8')]:[],...(draft?{draft}:{})})}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});};
const taskResult=amendment=>finish(JSON.stringify({answer:'Generated formal result: '+amendment,actions:[]}));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify({pid:process.pid,...m})+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:turnId}}});envelope=JSON.parse(m.params.input[0].text);let route;try{route=JSON.parse(envelope.request);}catch{}
  if(route?.task==='mote.conversation-disposition'){
   const task=route.candidates.find(item=>item.kind==='assistant.task');
   finish(JSON.stringify(route.message.question==='GENERATED-UNRELATED'?{kind:'independent'}:task?{kind:'task-supplement',targetTaskId:task.id,reply:'Generated amendment accepted by the formal task.'}:{kind:'independent'}));
  }else if(envelope.request==='GENERATED-DRAFT-REQUEST')finish('Generated initial draft answer',{goal:'Generated formal task goal'});
  else if(envelope.request.includes('Generated formal task goal')){isTask=true;send({id:9000,method:'item/tool/call',params:{threadId,turnId,namespace:null,tool:'evidence',arguments:{ids:[readFileSync(${JSON.stringify(evidencePath)},'utf8')]}}});}
  else finish('Generated independent answer: '+envelope.request);
 }else if(m.id===9000){if(m.result?.success!==true)process.exit(6);writeFileSync(${JSON.stringify(entered)},String(process.pid));const amendments=envelope.untrustedTaskContext?.ownerAmendments;
  if(amendments?.length)taskResult(amendments.map(item=>item.question).join(' | '));else {const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);taskResult('original task');}},10);}
 }else if(m.method==='turn/steer'){
  if(!isTask||m.params.expectedTurnId!==turnId||m.params.threadId!==threadId)process.exit(7);
  if(readFileSync(${JSON.stringify(modePath)},'utf8')==='drop-ack')process.exit(8);
  send({id:m.id,result:{turnId}});
  if(readFileSync(${JSON.stringify(modePath)},'utf8')==='hold-terminal'){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);taskResult(m.params.input[0].text);}},10);}else taskResult(m.params.input[0].text);
 }
});
`,{mode:0o700});
 const config:Config={dataDir:join(root,'vault'),dataKey:'72'.repeat(32),contentEncryptionEnabled:true,token:'generated-task-steering-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated-task-model',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',agentTimeoutMs:20000,codexBin:executable,codexHome:root};
 const open=()=>buildApp(config,{backgroundWorker:false});let node=await open();const headers={authorization:'Bearer '+config.token},id=(await node.app.inject({url:'/api/conversations/main',headers})).json().id as string;
 t.after(async()=>{writeFileSync(gate,'');await node.app.close();rmSync(root,{recursive:true,force:true});});
 const evidenceId=randomUUID(),note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:evidenceId,deviceId:'generated-task-device',deviceName:'Generated task fixture',platform:'import',capturedAt:new Date().toISOString(),text:'Generated formal task original evidence.'}});assert.equal(note.statusCode,201,note.body);writeFileSync(evidencePath,evidenceId);
 const scope={kind:'selection',evidenceIds:[evidenceId]};
 const rpc=()=>{try{return readFileSync(rpcPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
 const post=async(question:string,clientRequestId=randomUUID(),selected:Record<string,unknown>=scope)=>{const payload={conversationId:id,clientRequestId,question,scope:selected},response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(response.statusCode,202,response.body);return{message:response.json(),payload};};
 const settle=async(messageId:string)=>until(()=>{const value=node.conversations.message(messageId);return ['completed','failed','cancelled'].includes(value.status)?value:undefined;},'message '+messageId);
 const start=async()=>{const draft=await post('GENERATED-DRAFT-REQUEST'),turn=await settle(draft.message.id);assert.equal(turn.status,'completed',JSON.stringify(turn));assert.ok(turn.result?.draft);
  const value=turn.result.draft,response=await node.app.inject({method:'POST',url:'/api/assistant/commands',headers,payload:{conversationId:id,turnId:turn.id,requestId:value.requestId,expectedRevision:value.revision,capability:'assistant.task.start',goal:value.goal,scope:value.scope}});assert.equal(response.statusCode,200,response.body);
  await until(()=>existsSync(entered)?true:undefined,'formal background task reading its original');return{taskId:response.json().taskId as string,turn,draft:value};};
 const task=(taskId:string)=>node.store.db.prepare('SELECT state,revision,operation_id FROM task_records WHERE id=?').get(taskId)!;
 return{root,id,headers,scope,evidenceId,rpc,post,settle,start,task,get node(){return node;},release:()=>writeFileSync(gate,''),setMode:(mode:string)=>writeFileSync(modePath,mode),async restart(){await node.app.close();node=await open();}};
}

test('owner HTTP adjusts a real accepted assistant task through its own native turn and preserves the task/result conversation link',{timeout:30000},async t=>{
 const f=await fixture(t),original=await f.start();assert.equal(f.task(original.taskId).state,'running');
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');await until(()=>f.rpc().find(row=>row.method==='turn/steer'),'formal task native steering');
 const received=await f.settle(amendment.message.id);assert.equal(received.status,'completed',JSON.stringify(received));
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'the original formal task result');
 const view=f.node.assistantTasks.get(original.taskId,original.draft.scope);assert.equal(view.task.id,original.taskId);assert.match(view.result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);
 assert.equal(received.taskSteering?.targetTaskId,original.taskId);assert.equal(received.taskSteering?.state,'accepted');
 const linked=f.node.assistantTasks.byTurn(f.id,original.turn.id,original.draft.scope);assert.equal(linked.items.length,1);assert.equal(linked.items[0].task.id,original.taskId);
 const delivery=f.rpc().filter(row=>row.method==='turn/steer');assert.equal(delivery.length,1);assert.equal(f.rpc().filter(row=>row.pid===delivery[0].pid&&row.method==='turn/start').length,1);
});
