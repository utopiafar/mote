import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {OwnerQuestion} from '@mote/shared';
import {buildApp} from '../../src/app.js';
import type {ConfigurationPlatformOptions} from '../../src/config.js';

export const ownerAnswer='Generated A10 exact owner answer: use the first option.';
const goal='Generated A10 task goal',original='Generated A10 original: the choice is still unknown.';
export async function until(check:()=>boolean){
 const end=Date.now()+10000;
 while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Timed out waiting for generated assistant continuation');
}

/** Actual HTTP/query/executor/ledger path; only the loopback model is generated. */
export async function assistantQuestionFixture(t:TestContext){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-assistant-question-'));
 const headers={authorization:'Bearer generated-a10-owner'};
 let evidenceId='',continued=0,hold=false,wire='',forbiddenId='',release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const requests:Record<string,unknown>[]=[];
 const provider=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  const request=JSON.parse(body);requests.push(request);
  const isTask=body.includes(goal),isContinuation=body.includes(ownerAnswer),hasTool=request.messages.some((message:{role:string})=>message.role==='tool');
  let answer:unknown={answer:'Generated initial answer',citationIds:[],draft:{goal}};
  if(isTask){
   if(isContinuation){if(!hasTool)continued++;wire=body;if(hold){entered();await held;}
    answer={answer:JSON.stringify({answer:'Generated continued task result',actions:[]}),citationIds:[evidenceId]};
   }else answer={answer:JSON.stringify({state:'needs_owner_input',question:{
    prompt:'Which generated option should this task use?',reason:'The original does not establish a choice.',
    choices:[{id:'first',label:'Generated first option',answer:ownerAnswer}],evidence:[{id:evidenceId,quote:original,ref:'https://generated.invalid/untrusted-model-locator'}],
   }}),citationIds:[evidenceId]};
  }
  if(res.destroyed)return;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  const readOutside=isContinuation&&forbiddenId&&!hasTool;
  const delta=readOutside?{role:'assistant',tool_calls:[{index:0,id:'generated-outside-read',type:'function',function:{name:'evidence',arguments:JSON.stringify({ids:[forbiddenId]})}}]}:{role:'assistant',content:JSON.stringify(answer)};
  send({id:'generated-a10',choices:[{index:0,delta,finish_reason:null}]});
  send({id:'generated-a10',choices:[{index:0,delta:{},finish_reason:readOutside?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:ConfigurationPlatformOptions={path:(dataDir)+'/mote.yaml',privateCredential:{token:'generated-a10-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,dataKey:'72'.repeat(32),contentEncryptionEnabled:true,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-model',provider:'custom',protocol:'openai-completions',baseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,maxTokens:512,apiKey:'generated-only',allowUnauthenticatedLocal:false,reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false,level:'silent'}}};
 const build=async()=>{
  const node=await buildApp(config,{backgroundWorker:false});
  await node.app.ready();return node;
 };
 let node=await build();
 t.after(async()=>{release();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dataDir,{recursive:true,force:true});});
 const api=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload});
 const note=async(text=original)=>{
  const id=randomUUID(),response=await api('POST','/api/notes',{id,deviceId:'generated-a10-device',deviceName:'Generated',platform:'android',capturedAt:'2026-11-01T00:00:00Z',text});
  assert.equal(response.statusCode,201,response.body);return id;
 };
 const otherSource=async(text:string)=>{
  const source=await api('POST','/api/sources',{id:'generated-a10-other-source',name:'Generated other source',kind:'custom',deviceId:'generated-a10-device',platform:'import',retention:'archive'});
  assert.equal(source.statusCode,200,source.body);
  const item=await api('PUT','/api/sources/generated-a10-other-source/items',{externalId:'generated-other',revision:'1',observedAt:'2026-11-01T00:00:00Z',kind:'message',layer:'original',text});
  assert.equal(item.statusCode,200,item.body);return item.json().id as string;
 };
 evidenceId=await note();
 const draft=await api('POST','/api/query',{question:'Generated A10 initial request',evidenceIds:[evidenceId]});
 assert.equal(draft.statusCode,200,draft.body);const turn=draft.json();assert.ok(turn.draft);
 const command={conversationId:turn.conversationId,turnId:turn.turnId,requestId:turn.draft.requestId,expectedRevision:turn.draft.revision,capability:'assistant.task.start',goal,scope:turn.draft.scope};
 const start=async()=>{
  const response=await api('POST','/api/assistant/commands',command);assert.equal(response.statusCode,200,response.body);return response.json().taskId as string;
 };
 const questions=async()=>{
  const response=await api('GET','/api/owner-questions?'+new URLSearchParams({operationId:'assistant.task:'+command.requestId}));
  assert.equal(response.statusCode,200,response.body);return response.json().items as OwnerQuestion[];
 };
 const question=async()=>{
  await until(()=>Boolean(node.store.db.prepare("SELECT 1 FROM owner_questions WHERE json_extract(json,'$.operationId')=?").get('assistant.task:'+command.requestId)));
  const [value]=await questions();assert.ok(value);return value;
 };
 const read=async(taskId:string)=>{
  const response=await api('GET','/api/assistant/tasks/'+taskId+'?'+new URLSearchParams({scope:JSON.stringify(command.scope)}));
  assert.equal(response.statusCode,200,response.body);return response.json();
 };
 return {get node(){return node;},get continued(){return continued;},get wire(){return wire;},get evidenceId(){return evidenceId;},requests,command,api,note,otherSource,start,questions,question,read,started,
  tryReadOutside(id:string){forbiddenId=id;},
  hold(){hold=true;},release(){hold=false;release();},async restart(){await node.app.close();hold=false;release();node=await build();}};
}
