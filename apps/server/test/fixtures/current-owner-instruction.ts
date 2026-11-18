import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {buildApp} from '../../src/app.js';
import type {ConfigurationPlatformOptions} from '../../src/config.js';

export type ModelRequest={request:any;envelope:any;task:boolean;taskCalls:number;wire:string};
export const taskResult=(answer='Generated current-input task result: read for 20 minutes, write the recap, and review the next step.')=>({answer:JSON.stringify({answer,actions:[]}),citationIds:[]});
export const currentProposal=()=>({answer:'Generated self-contained instruction accepted for background work.',citationIds:[],draft:{goal:'Prepare the current-message reading and recap plan',input:'current-instruction'}});
export const ownerQuestion=()=>({answer:JSON.stringify({state:'needs_owner_input',question:{prompt:'Which generated output style should the plan use?',reason:'The current request does not choose an output style.',choices:[],evidence:[]}}),citationIds:[]});
export function gate(){let release!:()=>void;return{promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}
export const instruction='GENERATED CURRENT OWNER INSTRUCTION: Prepare a three-step plan from only this message: reserve 20 minutes for reading, then write a short recap. No archive lookup or external action is requested.';
export async function until<T>(read:()=>T|undefined|Promise<T|undefined>,label:string){const end=Date.now()+8000;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated current instruction did not settle: '+label);}
type FixtureOptions={
 connectors?:NonNullable<ConfigurationPlatformOptions['initialDocument']>['connectors'];
 connectorTesting?:NonNullable<Parameters<typeof buildApp>[1]>['connectorTesting'];
};
export async function currentInstructionFixture(t:TestContext,respond?:(input:ModelRequest)=>unknown|Promise<unknown>,options:FixtureOptions={}){
 const directory=mkdtempSync(join(tmpdir(),'mote-current-instruction-')),requests:any[]=[];let taskCalls=0;
 const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
  const envelopes=body.messages.filter((message:any)=>message.role==='user').flatMap((message:any)=>{try{const value=JSON.parse(message.content);return typeof value.request==='string'?[value]:[];}catch{return [];}}),envelope=envelopes.at(-1);assert.ok(envelope,'real Agent context envelope');
  const task=envelope.request.includes('Owner task:');if(task)taskCalls++;const generated=task?{answer:JSON.stringify({answer:'Generated current-input task result: read for 20 minutes, write the recap, and review the next step.',actions:[]}),citationIds:[]}:{answer:'Generated self-contained instruction accepted for background work.',citationIds:[],draft:{goal:'Prepare the current-message reading and recap plan',input:'current-instruction'}};
  const result=respond?await respond({request:body,envelope,task,taskCalls,wire:raw}):generated;
  if(res.destroyed)return;const call=result&&typeof result==='object'&&'tool' in result?(result as {tool:{name:string;arguments:unknown}}).tool:undefined;
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:'generated-current-tool',type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{role:'assistant',content:JSON.stringify(result)};
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'generated-current-instruction',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'generated-current-instruction',choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:40,completion_tokens:30,total_tokens:70}})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:'generated-current-instruction-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,dataKey:'51'.repeat(32),contentEncryptionEnabled:true,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-current-model',provider:'custom',protocol:'openai-completions',baseUrl:'http://127.0.0.1:'+(provider.address() as {port:number}).port+'/v1',apiKey:'generated-only',allowUnauthenticatedLocal:false,agentTimeoutMs:20000,reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false,level:'silent'}}};
 if(options.connectors)config.initialDocument!.connectors=options.connectors;
 const dependencies={backgroundWorker:false,connectorTesting:options.connectorTesting};
 let node=await buildApp(config,dependencies);await node.app.ready();const headers={authorization:'Bearer '+config.privateCredential!.token},conversationId=(await node.app.inject({url:'/api/conversations/main',headers})).json().id as string;
 t.after(async()=>{await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const post=async(question=instruction,clientRequestId=randomUUID(),extra:Record<string,unknown>={})=>{const payload={conversationId,clientRequestId,question,scope:{kind:'all'},...extra},response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(response.statusCode,202,response.body);return{message:response.json(),payload};};
 const settled=(id:string)=>until(()=>{const message=node.conversations.message(id);return ['completed','failed','cancelled'].includes(message.status)?message:undefined;},'owner message '+id);
 const api=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload});
 const task=(id:string)=>node.store.db.prepare('SELECT * FROM task_records WHERE id=?').get(id)!;
 const taskFor=async(id:string)=>String((await until(()=>node.store.db.prepare('SELECT task_id FROM assistant_task_turns WHERE turn_id=?').get(id),'Task linked to owner turn')).task_id);
 const read=async(id:string)=>{const message=node.conversations.message(id),response=await api('GET',`/api/conversations/${conversationId}/messages/${id}/assistant-tasks?`+new URLSearchParams({scope:JSON.stringify(message.result!.draft!.scope)}));assert.equal(response.statusCode,200,response.body);return response.json().items;};
 const note=async(text:string)=>{const id=randomUUID(),response=await api('POST','/api/notes',{id,deviceId:'generated-current-device',deviceName:'Generated',platform:'import',capturedAt:'2026-11-01T00:00:00Z',text});assert.equal(response.statusCode,201,response.body);return id;};
 return{directory,headers,conversationId,requests,post,settled,api,task,taskFor,read,note,get node(){return node;},async restart(beforeOpen?:()=>Promise<void>){await node.app.close();await beforeOpen?.();node=await buildApp(config,dependencies);await node.app.ready();}};
}
