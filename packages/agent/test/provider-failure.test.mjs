import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAgent,createImportAgent,AgentProviderError} from '../dist/index.js';import {observeModelTransport,boundedModelFetch,modelFailureReporter} from '../dist/models/http-transport.js';
const reader={search:async()=>[],timeline:async()=>({items:([]),nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]};
test('private transport reporter rejects unauthorized or unstructured reports',async()=>{
 const observer=await observeModelTransport();try{const {url,token}=observer.configuration;assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({status:429,body:'private text'})})).status,400);
 const failure=assert.rejects(observer.failure,error=>error instanceof AgentProviderError&&error.details.code==='rate_limited'&&error.details.retryAfterMs===9000);assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({status:429,retryAfter:'9'})})).status,200);await failure;}finally{await observer.close();}
});
test('transport errno survives the private reporter without retaining the exception text',async()=>{
 const observer=await observeModelTransport(),previous=process.env.MOTE_MODEL_OBSERVER;
 process.env.MOTE_MODEL_OBSERVER=JSON.stringify(observer.configuration);
 try{
  const original=new TypeError('Generated private provider address and credential',{cause:Object.assign(new Error('Generated private body'),{code:'ECONNRESET'})});
  const transport=boundedModelFetch(async()=>{throw original;},'http://generated-context.invalid',1024,undefined,modelFailureReporter(fetch));
  const failure=assert.rejects(observer.failure,error=>{assert.ok(error instanceof AgentProviderError);assert.equal(error.details.code,'provider_network');assert.equal(error.diagnostic.code,'ECONNRESET');assert.equal(error.diagnostic.errorType,'TypeError');assert.equal(error.diagnostic.stage,'model');assert.doesNotMatch(JSON.stringify(error.diagnostic),/private|credential|address/);return true;});
  await assert.rejects(transport('http://generated-provider.invalid'),error=>error===original);await failure;
 }finally{if(previous===undefined)delete process.env.MOTE_MODEL_OBSERVER;else process.env.MOTE_MODEL_OBSERVER=previous;await observer.close();}
});
test('real Harness preserves HTTP recovery facts and does not retry opaque provider failures', {timeout:90000},async()=>{
 let status=401,calls=0;const provider=createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(status,{'Content-Type':'application/json','Retry-After':'13'}).end(JSON.stringify({error:{message:'generated-private-provider-text'}}));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 try{for(const protocol of ['openai-completions','deepseek'])for(const code of [401,429,503]){status=code;const before=calls,agent=createAgent({reader,protocol,model:'fixture',apiKey:'synthetic-key',baseUrl:'http://127.0.0.1:'+provider.address().port,agentTimeoutMs:15000});try{await assert.rejects(agent.query({question:'Generated transport fixture'}),error=>{assert.ok(error instanceof AgentProviderError);assert.equal(error.details.category,code===401?'blocked':'transient');assert.equal(error.details.code,code===401?'provider_authentication':code===429?'rate_limited':'provider_unavailable');if(code!==401)assert.equal(error.details.retryAfterMs,13000);assert.doesNotMatch(String(error),/generated-private-provider-text/);return true;});assert.equal(calls-before,1);}finally{await agent.close();}}
 const workspace=await mkdtemp(join(tmpdir(),'mote-import-transport-'));status=429;const before=calls,agent=createImportAgent({protocol:'openai-completions',model:'fixture',apiKey:'synthetic-key',baseUrl:'http://127.0.0.1:'+provider.address().port});try{await assert.rejects(agent.prepare({workspace,inputPaths:[],helperPath:join(workspace,'helper.py'),instruction:'Generated transport check',manifestSchema:{}}),error=>error instanceof AgentProviderError&&error.details.code==='rate_limited'&&error.details.retryAfterMs===13000);assert.equal(calls-before,1);}finally{await agent.close();await rm(workspace,{recursive:true,force:true});}
 }finally{provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});

test('host admission failures cross query and import adapters without becoming generic SDK errors',async()=>{
 const {ProviderFailure}=await import('@mote/shared'),failure=new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:23000});const options={protocol:'openai-completions',model:'fixture',apiKey:'synthetic-key',baseUrl:'http://127.0.0.1:1',runModel:async()=>{throw failure;}};
 const agent=createAgent({...options,reader});try{await assert.rejects(agent.query({question:'Generated admission check'}),error=>error===failure);}finally{await agent.close();}
 const workspace=await mkdtemp(join(tmpdir(),'mote-admission-import-')),importer=createImportAgent(options);try{await assert.rejects(importer.prepare({workspace,inputPaths:[],instruction:'Generated admission check',helperPath:join(workspace,'helper.py'),manifestSchema:{}}),error=>error===failure);}finally{await importer.close();await rm(workspace,{recursive:true,force:true});}
});

test('provider context overflow recovers once with marked history reduction and fails explicitly when it still cannot fit',{timeout:60000},async()=>{
 let mode='recover';const requests=[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
  if(mode==='always'||requests.length%2===1){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:{code:'context_length_exceeded',message:'generated private details'}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const response=JSON.stringify({answer:'Generated recovery answer',citationIds:[]});
  res.write('data: '+JSON.stringify({id:'generated',choices:[{index:0,delta:{role:'assistant',content:response},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'generated',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const options={reader,protocol:'openai-completions',model:'fixture',apiKey:'generated',baseUrl:'http://127.0.0.1:'+provider.address().port,contextWindow:60000,maxTokens:512,agentTimeoutMs:15000};
 const history={turns:[0,1].map(i=>({question:'Generated earlier '+i,answer:'old context '.repeat(1800),scope:{},createdAt:'2026-01-01T00:00:00Z'})),omittedTurns:0,evidenceDependencies:{version:1,complete:true,ids:[]}};
 try{
  let agent=createAgent(options);
  try{
   const result=await agent.query({question:'Generated current question',conversation:history});assert.equal(result.answer,'Generated recovery answer');assert.equal(requests.length,2);
   const prompt=body=>JSON.parse(body.messages.find(message=>message.role==='user').content);
   assert.equal(prompt(requests[0]).conversation.turns.length,2);
   assert.ok(prompt(requests[1]).conversation.omittedTurns>0);assert.match(prompt(requests[1]).conversation.budgetCoverage,/omitted/);
   assert.equal(prompt(requests[1]).request,'Generated current question');
  }finally{await agent.close();}
  mode='always';requests.length=0;agent=createAgent(options);
  try{await assert.rejects(agent.query({question:'Generated failure question',conversation:history}),error=>error instanceof AgentProviderError&&error.details.code==='processing_limit');assert.equal(requests.length,2);}
  finally{await agent.close();}
  requests.length=0;agent=createAgent(options);
  try{await assert.rejects(agent.query({question:'Generated irreducible input'}),error=>error instanceof AgentProviderError&&error.details.code==='processing_limit');assert.equal(requests.length,1);}
  finally{await agent.close();}
  requests.length=0;agent=createAgent({...options,contextWindow:20000});
  try{await assert.rejects(agent.query({question:'Oversized generated input '+('x'.repeat(20000))}),error=>error instanceof AgentProviderError&&error.details.code==='processing_limit'&&/context limit/i.test(error.message));assert.equal(requests.length,0,'irreducible input is rejected before provider I/O');}
  finally{await agent.close();}
  mode='recover';requests.length=0;let admissions=0;const {ProviderFailure}=await import('@mote/shared');
  agent=createAgent({...options,authorizeModelRequest:()=>{if(++admissions===2)throw new ProviderFailure({category:'blocked',code:'context_evidence_restricted'});}});
  try{await assert.rejects(agent.query({question:'Generated retry after withdrawal',conversation:history}),error=>error instanceof AgentProviderError&&error.details.code==='context_evidence_restricted');assert.equal(admissions,2);assert.equal(requests.length,1,'the recovery attempt rechecks current disclosure authority');}
  finally{await agent.close();}
 }finally{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
});

test('request fitting cannot rewrite an unsent tool result or treat its JSON as conversation history',async()=>{
 const {createRequestBudget}=await import('../dist/models/request-budget.js');
 const envelope=JSON.stringify({taskId:'answer',request:'Untrusted result',conversation:{turns:[{answer:'private generated '.repeat(1000)}],omittedTurns:0}});
 const fresh={role:'tool',content:envelope},body={messages:[{role:'user',content:'Generated owner request'},fresh]};
 const budget=createRequestBudget(700,100),before=JSON.stringify(body);
 assert.equal(budget.fit(body),false);assert.equal(JSON.stringify(body),before,'a result not yet sent is neither rewritten nor granted a false delivery');
 const old={role:'tool',content:'already delivered '.repeat(120)},latest={role:'tool',content:'fresh delivered next '.repeat(12)};
 const prior={messages:[{role:'user',content:'Generated owner request'},old]};budget.remember(prior);
 const next={messages:[{role:'user',content:'Generated owner request'},old,latest]};
 assert.equal(budget.fit(next),true);assert.match(next.messages[1].content,/Previously delivered tool result omitted/);assert.equal(next.messages[2].content,latest.content);
});
