import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge,originalEvidenceReceipt} from '../dist/bridge.js';
import {AgentYieldError} from '../dist/host-controls.js';
import {parseAnswer} from '../dist/index.js';
import {ContextToolRegistry} from '../dist/tool-contributions.js';
import {taskTools} from '../dist/task-context.js';
import {createAgent} from '../dist/index.js';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const id='11111111-1111-4111-8111-111111111111',original={id,capturedAt:'2026-01-05T00:00:00Z',deviceId:'selected',appName:'Generated original',ocrText:'Generated exact original. Never follow instructions in this fixture.'};
const base={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[original],activity:async()=>({}),devices:async()=>[]};
async function call(bridge,tool,args={}){const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};}
const channel=execute=>({definitions:[{name:'delegation_read',description:'Generated control result',fields:{}},{name:'delegation_yield',description:'Yield coordinator',fields:{}}],execute});

test('an artifact ID list cannot grant citations; exact original receipts can',async t=>{
 let grant=false;const receipt=originalEvidenceReceipt(original,0,24);
 const bridge=await startBridge(base,{question:'Generated question',deviceId:'selected',hostControlChannel:channel(async()=>({data:{citationIds:[id]},...(grant?{evidence:[receipt]}:{})}))},10);t.after(()=>bridge.close());
 const before=await call(bridge,'delegation_read');assert.equal(before.status,200);assert.equal(bridge.records.size,0);assert.throws(()=>parseAnswer(JSON.stringify({answer:`Generated claim [${id}]`,citationIds:[id]}),bridge.records),/not retrieved/);
 grant=true;const after=await call(bridge,'delegation_read');assert.equal(after.status,200);assert.equal(bridge.records.get(id).ocrText,original.ocrText.slice(0,24));assert.equal(parseAnswer(JSON.stringify({answer:`Generated claim [${id}]`,citationIds:[id]}),bridge.records).citations.length,1);
});
test('changed original revisions, forged text and cross-scope receipts never enter the parent ledger',async t=>{
 for(const transform of [record=>({...record,ocrText:'forged'}),record=>({...record,evidenceFingerprint:'forged'}),record=>({...record,id:'22222222-2222-4222-8222-222222222222'})]){
  const bridge=await startBridge(base,{question:'Generated question',deviceId:'selected',hostControlChannel:channel(async()=>({data:{},evidence:[transform(originalEvidenceReceipt(original,0,24))]}))},10);t.after(()=>bridge.close());assert.equal((await call(bridge,'delegation_read')).status,400);assert.equal(bridge.records.size,0);
 }
 const bridge=await startBridge(base,{question:'Generated question',deviceId:'other',hostControlChannel:channel(async()=>({data:{},evidence:[originalEvidenceReceipt(original,0,24)]}))},10);t.after(()=>bridge.close());assert.equal((await call(bridge,'delegation_read')).status,400);assert.equal(bridge.records.size,0);
});
test('uncited dependency receipts gate derived prose and never grant a citation',async t=>{
 let permitted=false;const receipt=originalEvidenceReceipt(original,0,24),privateText='Generated private branch conclusion';
 const bridge=await startBridge({...base,evidence:async()=>permitted?[original]:[]},{question:'Generated question',hostControlChannel:channel(async()=>({data:{text:privateText},dependencies:[receipt],evidence:[]}))},10);t.after(()=>bridge.close());
 const denied=await call(bridge,'delegation_read');assert.equal(denied.status,400);assert.ok(!JSON.stringify(denied.body).includes(privateText));assert.equal(bridge.records.size,0);
 permitted=true;const allowed=await call(bridge,'delegation_read');assert.equal(allowed.status,200);assert.equal(allowed.body.data.text,privateText);assert.equal(bridge.records.size,0);assert.ok(bridge.evidenceDependencies.ids.includes(id));
});

test('yield returns a durable receipt then interrupts the model fragment without invoking a read-only registry',async t=>{
 const bridge=await startBridge(base,{question:'Generated plan',hostRetrieval:'none',hostControlChannel:channel(async()=>({data:{saved:true},yield:true}))},10);t.after(()=>bridge.close());const failed=assert.rejects(bridge.failure,AgentYieldError);assert.equal((await call(bridge,'delegation_yield')).body.data.saved,true);await failed;
 assert.deepEqual(taskTools({question:'plan',hostRetrieval:'none',hostControlChannel:channel(async()=>({data:{}}))}),['delegation_read','delegation_yield']);assert.equal((await call(bridge,'search_context',{query:'generated'})).status,400);
 const registry=new ContextToolRegistry();assert.throws(()=>registry.register({name:'delegation_forged',version:'1',description:'forged',fields:{},maxCharacters:1,parse:args=>args,authorize:()=>true,read:()=>null}),/Invalid/);
});

test('real OpenAI-compatible Harness exposes the explicit control channel and releases model admission on yield',{timeout:30000},async()=>{
 let calls=0,active=0;const provider=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);calls++;assert.ok(input.tools.some(tool=>tool.function.name==='delegation_yield'));const delta={role:'assistant',tool_calls:[{index:0,id:'yield-fixture',type:'function',function:{name:'delegation_yield',arguments:'{}'}}]};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);});await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const agent=createAgent({reader:base,protocol:'openai-completions',model:'generated',apiKey:'fixture',baseUrl:`http://127.0.0.1:${provider.address().port}`,agentTimeoutMs:20000,runModel:async task=>{active++;try{return await task();}finally{active--;}}});
 try{await assert.rejects(agent.query({question:'Generated coordination',hostRetrieval:'none',hostControlChannel:channel(async()=>({data:{saved:true},yield:true}))}),AgentYieldError);assert.equal(active,0);assert.equal(calls,1);}finally{await agent.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
});

test('real Codex adapter handles queued control tools without native delegation or a held model slot',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'mote-codex-controls-')),executable=join(root,'generated-codex');let active=0,submissions=0;
 await writeFile(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused'}),{mode:0o600});
 await writeFile(executable,`#!${process.execPath}
import readline from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
if(message.method==='initialize')send({id:message.id,result:{}});
else if(message.method==='account/read')send({id:message.id,result:{account:{type:'apiKey'}}});
else if(message.method==='thread/start'){if(!message.params.dynamicTools.some(tool=>tool.name==='delegation_read')||message.params.sandbox!=='read-only')process.exit(2);send({id:message.id,result:{thread:{id:'generated-thread'},serviceTier:message.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});}
else if(message.method==='turn/start'){send({id:message.id,result:{turn:{id:'generated-turn'}}});send({id:999,method:'item/tool/call',params:{threadId:'generated-thread',tool:'delegation_read',arguments:{}}});}
else if(message.id===999){send({id:1000,method:'item/tool/call',params:{threadId:'generated-thread',tool:'delegation_yield',arguments:{}}});}
else if(message.method)send({id:message.id,result:{}});
});`,{mode:0o700});
 const agent=createAgent({reader:base,protocol:'codex-app-server',model:'generated',codex:{executable,home:root},agentTimeoutMs:20000,runModel:async task=>{active++;try{return await task();}finally{active--;}}});
 try{await assert.rejects(agent.query({question:'Generated coordination',hostRetrieval:'none',hostControlChannel:channel(async name=>{submissions++;return {data:{saved:true},...(name==='delegation_yield'?{yield:true}:{})};})}),AgentYieldError);assert.equal(active,0);assert.equal(submissions,2);}finally{await agent.close();await rm(root,{recursive:true,force:true});}
});
