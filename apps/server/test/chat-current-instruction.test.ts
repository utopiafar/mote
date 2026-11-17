import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const instruction='GENERATED CURRENT OWNER INSTRUCTION: Prepare a three-step plan from only this message: reserve 20 minutes for reading, then write a short recap. No archive lookup or external action is requested.';
async function until<T>(read:()=>T|undefined|Promise<T|undefined>,label:string){const end=Date.now()+8000;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated current instruction did not settle: '+label);}
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-current-instruction-')),requests:any[]=[];
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
  const envelopes=body.messages.filter((message:any)=>message.role==='user').flatMap((message:any)=>{try{const value=JSON.parse(message.content);return typeof value.request==='string'?[value]:[];}catch{return [];}}),envelope=envelopes.at(-1);assert.ok(envelope,'real Agent context envelope');
  const task=envelope.request.includes('Owner task:');const result=task?{answer:JSON.stringify({answer:'Generated current-input task result: read for 20 minutes, write the recap, and review the next step.',actions:[]}),citationIds:[]}:{answer:'Generated self-contained instruction accepted for background work.',citationIds:[],draft:{goal:'Prepare the current-message reading and recap plan',input:'current-instruction'}};
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'generated-current-instruction',choices:[{index:0,delta:{role:'assistant',content:JSON.stringify(result)},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'generated-current-instruction',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:30,total_tokens:70}})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,dataKey:'51'.repeat(32),contentEncryptionEnabled:true,token:'generated-current-instruction-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated-current-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:'+(provider.address() as {port:number}).port+'/v1',apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',agentTimeoutMs:20000};
 let node=await buildApp(config,{backgroundWorker:false});await node.app.ready();const headers={authorization:'Bearer '+config.token},conversationId=(await node.app.inject({url:'/api/conversations/main',headers})).json().id as string;
 t.after(async()=>{await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const post=async(question=instruction,clientRequestId=randomUUID())=>{const payload={conversationId,clientRequestId,question,scope:{kind:'all'}},response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(response.statusCode,202,response.body);return{message:response.json(),payload};};
 const settled=(id:string)=>until(()=>{const message=node.conversations.message(id);return ['completed','failed','cancelled'].includes(message.status)?message:undefined;},'owner message '+id);
 return{headers,conversationId,requests,post,settled,get node(){return node;},async restart(){await node.app.close();node=await buildApp(config,{backgroundWorker:false});await node.app.ready();}};
}

test('an explicit self-contained owner instruction starts the real Task without an archive capture or another start command',{timeout:30000},async t=>{
 const f=await fixture(t);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);const admitted=await f.post(),message=await f.settled(admitted.message.id);assert.equal(message.status,'completed',JSON.stringify(message));
 const row=await until(()=>f.node.store.db.prepare("SELECT id,state FROM task_records WHERE kind='assistant.task'").get(),'canonical AssistantTasks admission');await until(()=>{const task=f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(row.id);if(['failed','blocked','stale','cancelled'].includes(String(task?.state)))assert.fail(JSON.stringify({task,steps:f.node.store.db.prepare('SELECT state,error FROM execution_steps WHERE operation_id=(SELECT operation_id FROM task_records WHERE id=?)').all(row.id),requests:f.requests.length}));return task?.state==='succeeded'?true:undefined;},'current-input Task result');
 const detail=await f.node.app.inject({url:`/api/conversations/${f.conversationId}/messages/${message.id}/assistant-tasks?`+new URLSearchParams({scope:JSON.stringify(message.result!.draft!.scope)}),headers:f.headers});assert.equal(detail.statusCode,200,detail.body);const [item]=detail.json().items;assert.equal(item.task.id,row.id);assert.equal(item.task.state,'completed');assert.match(item.result.answer,/read for 20 minutes/);assert.deepEqual(item.result.citations,[]);assert.deepEqual(item.task.evidenceDependencies.ids,[]);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0,'owner instructions remain private Task input, never fabricated retrieval evidence');assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE operation_id=? AND kind='batch.item'").get(item.workId)!.n,1);
 const taskRequest=f.requests.find(request=>JSON.stringify(request).includes('Owner task:'));assert.ok(taskRequest);assert.ok(JSON.stringify(taskRequest).includes(instruction),'the exact owner words reach the real model consumer');assert.deepEqual((taskRequest.tools??[]).map((tool:any)=>tool.function.name),['skill'],'only the existing read-only procedure catalog remains; archive and external Action tools are absent');
 const duplicate=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:f.headers,payload:admitted.payload});assert.equal(duplicate.statusCode,202,duplicate.body);assert.equal(duplicate.json().id,message.id);await f.restart();assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,1);assert.equal(f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(row.id)!.state,'succeeded');
});
