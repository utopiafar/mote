import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {writeMessagesResponse} from '../../../../scripts/fixtures/messages-provider.js';
import {buildApp} from '../../src/app.js';
import type {Config} from '../../src/config.js';

export async function until<T>(read:()=>T|undefined|Promise<T|undefined>,label:string){const end=Date.now()+8000;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated formal task did not settle: '+label);}
export async function taskSteeringFixture(t:TestContext,{runtime='codex'}:{runtime?:'codex'|'dsh'}={}){
  const root=mkdtempSync(join(tmpdir(),'mote-assistant-task-steering-')),rpcPath=join(root,'rpc.ndjson'),executable=join(root,'generated-codex'),entered=join(root,'task-entered'),gate=join(root,'release-task'),queuedGate=join(root,'release-queued'),targetPath=join(root,'target-task'),ackGate=join(root,'release-ack'),routeGate=join(root,'release-route'),modePath=join(root,'mode'),evidencePath=join(root,'evidence-id');
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
 else if(m.method==='model/list')send({id:m.id,result:{data:[],nextCursor:null}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:turnId}}});envelope=JSON.parse(m.params.input[0].text);let route;try{route=JSON.parse(envelope.request);}catch{}
  if(route?.task==='mote.conversation-disposition'){
   const tasks=route.candidates.filter(item=>item.kind==='assistant.task'),target=existsSync(${JSON.stringify(targetPath)})?readFileSync(${JSON.stringify(targetPath)},'utf8'):undefined,task=tasks.find(item=>item.id===target)??tasks[0];
   const disposition=()=>finish(JSON.stringify(['GENERATED-UNRELATED','GENERATED-QUEUED-DRAFT-REQUEST'].includes(route.message.question)?{kind:'independent'}:task?{kind:'task-supplement',targetTaskId:readFileSync(${JSON.stringify(modePath)},'utf8')==='unlisted-task'?'77777777-7777-4777-8777-777777777777':task.id,reply:'Generated amendment accepted by the formal task.'}:{kind:'independent'}));if(readFileSync(${JSON.stringify(modePath)},'utf8')==='hold-route'){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(routeGate)})){clearInterval(timer);disposition();}},10);}else disposition();
  }else if(['GENERATED-DRAFT-REQUEST','GENERATED-QUEUED-DRAFT-REQUEST'].includes(envelope.request))finish('Generated initial draft answer',{goal:'Generated formal task goal'+(envelope.request==='GENERATED-QUEUED-DRAFT-REQUEST'?' [queued]':'')});
  else if(envelope.request.includes('Generated formal task goal')){isTask=true;send({id:9000,method:'item/tool/call',params:{threadId,turnId,namespace:null,tool:'evidence',arguments:{ids:[readFileSync(${JSON.stringify(evidencePath)},'utf8')]}}});}
  else finish('Generated independent answer: '+envelope.request);
 }else if(m.id===9000){if(m.result?.success!==true)process.exit(6);writeFileSync(${JSON.stringify(entered)},String(process.pid));const amendments=envelope.untrustedTaskContext?.ownerAmendments;
  if(amendments?.length)taskResult(amendments.map(item=>item.question).join(' | '));else if(readFileSync(${JSON.stringify(modePath)},'utf8')==='question')finish(JSON.stringify({state:'needs_owner_input',question:{prompt:'Generated missing task choice?',reason:'Generated evidence leaves the choice open.',choices:[],evidence:[]}}));else {const timer=setInterval(()=>{if(existsSync(envelope.request.includes('[queued]')?${JSON.stringify(queuedGate)}:${JSON.stringify(gate)})){clearInterval(timer);taskResult('original task'+(envelope.untrustedTaskContext?.ownerClarificationReply?.map(item=>' | '+item.reply).join('')??''));}},10);}
 }else if(m.method==='turn/steer'){
  if(!isTask||m.params.expectedTurnId!==turnId||m.params.threadId!==threadId)process.exit(7);
  if(readFileSync(${JSON.stringify(modePath)},'utf8')==='drop-ack')process.exit(8);
  const accept=()=>{send({id:m.id,result:{turnId}});
   if(readFileSync(${JSON.stringify(modePath)},'utf8')==='hold-terminal'){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(gate)})){clearInterval(timer);taskResult(m.params.input[0].text);}},10);}else taskResult(m.params.input[0].text);
  };
  if(readFileSync(${JSON.stringify(modePath)},'utf8')==='hold-ack'){const timer=setInterval(()=>{if(existsSync(${JSON.stringify(ackGate)})){clearInterval(timer);accept();}},10);}else accept();
 }
});
`,{mode:0o700});
 const requests:any[]=[];let releaseModel!:()=>void;const released=new Promise<void>(resolve=>{releaseModel=resolve;});
 const provider=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const request=JSON.parse(body);requests.push(request);
  const content=request.messages.filter((message:any)=>message.role==='user').at(-1).content,envelope=JSON.parse(typeof content==='string'?content:content.find((part:any)=>part.type==='text').text);let route;try{route=JSON.parse(envelope.request);}catch{}
  let answer:string,draft:unknown;
  if(route?.task==='mote.conversation-disposition'){const task=route.candidates.find((item:any)=>item.kind==='assistant.task');answer=JSON.stringify(route.message.question==='GENERATED-UNRELATED'||!task?{kind:'independent'}:{kind:'task-supplement',targetTaskId:task.id,reply:'Generated task continuation receipt.'});}
  else if(envelope.request==='GENERATED-DRAFT-REQUEST'){answer='Generated initial draft answer';draft={goal:'Generated formal task goal'};}
  else if(envelope.request.includes('Generated formal task goal')){writeFileSync(entered,'dsh');const amendments=envelope.untrustedTaskContext?.ownerAmendments;
   if(!amendments?.length||readFileSync(modePath,'utf8')==='hold-continuation')await released;
   answer=JSON.stringify({answer:'Generated formal result: '+(amendments?.map((item:any)=>item.question).join(' | ')??'original task'),actions:[]});
  }else answer='Generated independent answer: '+envelope.request;
  if(!res.destroyed)writeMessagesResponse(res,{stage:0,model:request.model,text:JSON.stringify({answer,citationIds:[],...(draft?{draft}:{})})});
 });await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:join(root,'vault'),dataKey:'72'.repeat(32),contentEncryptionEnabled:true,token:'generated-task-steering-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated-task-model',modelProvider:runtime==='codex'?'codex':'deepseek',modelProtocol:runtime==='codex'?'codex-app-server':'deepseek',modelBaseUrl:runtime==='codex'?'':'http://127.0.0.1:'+(provider.address() as {port:number}).port,apiKey:runtime==='codex'?'':'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',agentTimeoutMs:20000,codexBin:executable,codexHome:root};
 const open=async()=>{const opened=await buildApp(config,{backgroundWorker:false});await opened.app.ready();return opened;};let node=await open();const headers={authorization:'Bearer '+config.token},id=(await node.app.inject({url:'/api/conversations/main',headers})).json().id as string;
 t.after(async()=>{writeFileSync(gate,'');writeFileSync(queuedGate,'');writeFileSync(ackGate,'');writeFileSync(routeGate,'');releaseModel();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(root,{recursive:true,force:true});});
 const evidenceId=randomUUID(),note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:evidenceId,deviceId:'generated-task-device',deviceName:'Generated task fixture',platform:'import',capturedAt:new Date().toISOString(),text:'Generated formal task original evidence.'}});assert.equal(note.statusCode,201,note.body);writeFileSync(evidencePath,evidenceId);
 const scope={kind:'selection',evidenceIds:[evidenceId]};
 const rpc=()=>{try{return readFileSync(rpcPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
 const post=async(question:string,clientRequestId=randomUUID(),selected:Record<string,unknown>=scope,extra:Record<string,unknown>={})=>{const payload={conversationId:id,clientRequestId,question,scope:selected,...extra},response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(response.statusCode,202,response.body);return{message:response.json(),payload};};
 const settle=async(messageId:string)=>until(()=>{const value=node.conversations.message(messageId);return ['completed','failed','cancelled'].includes(value.status)?value:undefined;},'message '+messageId);
 const start=async(question='GENERATED-DRAFT-REQUEST')=>{const draft=await post(question),turn=await settle(draft.message.id);assert.equal(turn.status,'completed',JSON.stringify(turn));assert.ok(turn.result?.draft);
  const value=turn.result.draft,response=await node.app.inject({method:'POST',url:'/api/assistant/commands',headers,payload:{conversationId:id,turnId:turn.id,requestId:value.requestId,expectedRevision:value.revision,capability:'assistant.task.start',goal:value.goal,scope:value.scope}});assert.equal(response.statusCode,200,response.body);
  await until(()=>existsSync(entered)?true:undefined,'formal background task reading its original');return{taskId:response.json().taskId as string,turn,draft:value};};
 const task=(taskId:string)=>node.store.db.prepare('SELECT state,revision,operation_id FROM task_records WHERE id=?').get(taskId)!;
 const models=async()=>{const response=await node.app.inject({url:'/api/model-settings',headers});assert.equal(response.statusCode,200,response.body);return response.json();};
 const copyProfile=async(id:string)=>{const view=await models(),response=await node.app.inject({method:'POST',url:'/api/model-settings/profiles/'+view.defaults.chat+'/copy',headers,payload:{revision:view.revision,id,name:'Generated '+id}});assert.equal(response.statusCode,200,response.body);return response.json();};
 const selectProfile=async(id:string)=>{const view=await models(),response=await node.app.inject({method:'PUT',url:'/api/model-settings/defaults',headers,payload:{revision:view.revision,defaults:{...view.defaults,chat:id},defaultModels:view.defaultModels}});assert.equal(response.statusCode,200,response.body);return response.json();};
 const removeProfile=async(id:string)=>{const view=await models(),response=await node.app.inject({method:'DELETE',url:'/api/model-settings/profiles/'+id,headers,payload:{revision:view.revision}});assert.equal(response.statusCode,200,response.body);return response.json();};

 return{root,id,headers,scope,evidenceId,rpc,requests,post,settle,start,task,models,copyProfile,selectProfile,removeProfile,get node(){return node;},release:()=>{writeFileSync(gate,'');releaseModel();},releaseQueued:()=>writeFileSync(queuedGate,''),setTargetTask:(id:string)=>writeFileSync(targetPath,id),releaseAck:()=>writeFileSync(ackGate,''),releaseRoute:()=>writeFileSync(routeGate,''),setMode:(mode:string)=>writeFileSync(modePath,mode),async cancel(messageId:string){return node.app.inject({method:'POST',url:`/api/conversations/${id}/messages/${messageId}/cancel`,headers});},async restart(){await node.app.close();node=await open();}};
}
