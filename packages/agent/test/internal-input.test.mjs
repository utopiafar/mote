import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgent,AgentInputError,AgentProviderError} from '../dist/index.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.ts';

const originals=Array.from({length:3},(_,index)=>({id:`00000000-0000-4000-8000-00000000000${index+1}`,capturedAt:'2099-01-01T00:00:00Z',appName:'Generated internal request',ocrText:`Generated original ${index}: `+'正文🌱\\\"\n'.repeat(450)+` Exact original tail ${index}.`}));
const members=originals.map((record,index)=>({key:String(index+1).repeat(64),id:record.id,offset:0,length:record.ocrText.length,fingerprint:'a'.repeat(64),state:'pending',memoryIds:[]}));
const reader={search:async()=>originals,timeline:async()=>({items:originals,nextCursor:null}),evidence:async({ids})=>originals.filter(record=>ids.includes(record.id)),activity:async()=>({}),devices:async()=>[]};
const question='Generated host policy with complete source attribution and evidence requirements. '.repeat(300)+' Exact policy tail.';
const instruction='Assess every supplied original range in full, preserving uncertainty and exact quotes. '.repeat(280)+' Exact coverage instruction tail.';
const fixtureBudget={contextWindow:200000,maxTokens:16384};
const request=()=>({question,responseMode:'memory-extraction',evidenceIds:originals.map(record=>record.id),evidenceRanges:members.map(({id,offset,length})=>({id,offset,length})),taskContext:{turns:[],memoryWork:{workContract:'range-evaluation@1',members,contextMembers:[],authorizedMembers:members,history:[],instruction}}});

function generatedAnswer(envelope){return {answer:JSON.stringify({memories:[],coverage:envelope.untrustedTaskContext.memoryWork.members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]})),proof:envelope.untrustedEvidence.map(record=>({id:record.id,quote:record.ocrText}))}),citationIds:envelope.untrustedEvidence.map(record=>record.id)};}
function assertEnvelope(envelope){
 assert.equal(envelope.request,question);assert.ok(envelope.request.length>20000);
 const work=envelope.untrustedTaskContext.memoryWork;assert.equal(work.instruction,instruction);assert.equal(work.workContract,'range-evaluation@1');
 assert.deepEqual(work.members.map(({id,offset,length})=>({id,offset,length})),members.map(({id,offset,length})=>({id,offset,length})));
 assert.deepEqual(envelope.untrustedEvidence.map(({id,ocrText})=>({id,ocrText})),originals.map(({id,ocrText})=>({id,ocrText})));
}
function assertOutput(result){
 const output=JSON.parse(result.answer);assert.deepEqual(output.coverage,members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]})));
 assert.deepEqual(output.proof,originals.map(record=>({id:record.id,quote:record.ocrText})));assert.deepEqual(result.citations.map(({id})=>id),originals.map(({id})=>id));
}
async function readProviderBody(stream){
 const chunks=[];for await(const chunk of stream)chunks.push(chunk);
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
test('generated HTTP provider preserves UTF-8 at every request chunk boundary',async()=>{
 const expected={question:'Generated 正文🌱 and emoji 😀',evidence:['完整原文']},bytes=Buffer.from(JSON.stringify(expected));
 for(let at=1;at<bytes.length;at++)assert.deepEqual(await readProviderBody([bytes.subarray(0,at),bytes.subarray(at)]),expected,'split at byte '+at);
});
async function provider(t,protocol,reject=false){
 const requests=[],server=createServer(async(req,res)=>{
  const body=await readProviderBody(req);requests.push(body);
  if(reject){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Generated capacity rejection'}}));return;}
  const message=body.messages.find(message=>message.role==='user'),text=typeof message.content==='string'?message.content:message.content.find(block=>block.type==='text').text,envelope=JSON.parse(text);
  assertEnvelope(envelope);const answer=JSON.stringify(generatedAnswer(envelope));
  if(protocol==='deepseek'){writeMessagesResponse(res,{stage:0,model:'generated',text:answer});return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return {requests,baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
}
async function codex(t,reject=false){
 const root=await mkdtemp(join(tmpdir(),'mote-internal-input-')),executable=join(root,'generated-codex');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused-key'}),{mode:0o600});
 await writeFile(executable,`#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);appendFileSync(${JSON.stringify(join(root,'rpc.ndjson'))},line+'\\n');
 if(message.method==='initialize')send({id:message.id,result:{}});
 else if(message.method==='account/read')send({id:message.id,result:{account:{type:'apiKey'}}});
 else if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'generated-thread'},model:message.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(message.method==='turn/start'){
  if(${JSON.stringify(reject)}){send({id:message.id,error:{code:-32602,data:{input_error_code:'input_too_large',max_chars:10000,actual_chars:Array.from(message.params.input[0].text).length}}});return;}
  const envelope=JSON.parse(message.params.input[0].text),answer=(${generatedAnswer.toString()})(envelope);
  send({id:message.id,result:{turn:{id:'generated-turn'}}});
  send({method:'item/completed',params:{threadId:'generated-thread',item:{id:'generated-answer',type:'agentMessage',text:JSON.stringify(answer)}}});
  send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});return {options:{codex:{executable,home:root}},turns:async()=>((await readFile(join(root,'rpc.ndjson'),'utf8')).trim().split('\n').map(JSON.parse)).filter(message=>message.method==='turn/start')};
}

for(const protocol of ['deepseek','openai-completions','codex-app-server']){
 test(`${protocol} delivers an internal question beyond 20000 with complete original ranges and coverage`,{timeout:30000},async t=>{
  const fixture=protocol==='codex-app-server'?await codex(t):await provider(t,protocol),agent=createAgent({reader,protocol,model:'generated',apiKey:'generated',...fixtureBudget,agentTimeoutMs:20000,...(fixture.options??{baseUrl:fixture.baseUrl})});t.after(()=>agent.close());let validations=0;
  const result=await agent.query({...request(),validateOutput:result=>{validations++;assertOutput(result);}});assertOutput(result);assert.equal(validations,1);
  if(fixture.turns){const turns=await fixture.turns();assert.equal(turns.length,1);assertEnvelope(JSON.parse(turns[0].params.input[0].text));}else assert.equal(fixture.requests.length,1);
 });
 test(`${protocol} rejects an empty host question permanently before model execution`,async t=>{
  let admissions=0;const agent=createAgent({reader,protocol,model:'generated',...(protocol==='codex-app-server'?{codex:{executable:'/generated/no-runtime-must-start'}}:{apiKey:'generated',baseUrl:'http://127.0.0.1:9/v1'}),runModel:async task=>{admissions++;return task();}});t.after(()=>agent.close());
  for(const question of ['', ' \n\t '])await assert.rejects(agent.query({question}),error=>error instanceof AgentInputError&&error.details.category==='permanent'&&error.details.code==='invalid_agent_input'&&error.details.executionStarted===false);
  assert.equal(admissions,0);
 });
 test(`${protocol} preserves a real capacity failure without truncation or automatic retries`,{timeout:30000},async t=>{
  const fixture=protocol==='codex-app-server'?await codex(t,true):await provider(t,protocol,true),agent=createAgent({reader,protocol,model:'generated',apiKey:'generated',...fixtureBudget,agentTimeoutMs:20000,...(fixture.options??{baseUrl:fixture.baseUrl})});t.after(()=>agent.close());
  await assert.rejects(agent.query(request()),error=>error instanceof AgentProviderError&&error.details.category==='permanent'&&error.details.code==='processing_limit');
  if(fixture.turns){const turns=await fixture.turns();assert.equal(turns.length,1);assertEnvelope(JSON.parse(turns[0].params.input[0].text));}else {assert.equal(fixture.requests.length,1);const message=fixture.requests[0].messages.find(message=>message.role==='user');assertEnvelope(JSON.parse(typeof message.content==='string'?message.content:message.content.find(block=>block.type==='text').text));}
 });
}
