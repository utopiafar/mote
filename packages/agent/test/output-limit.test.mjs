import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createAgent,AgentResponseError} from '../dist/index.js';
const record={id:'11111111-1111-4111-8111-111111111111',capturedAt:'2026-09-16T00:00:00Z',appName:'Generated notes',ocrText:'A generated document review was completed.'};
const reader={search:async()=>[record],timeline:async()=>[record],evidence:async()=>[record],activity:async()=>({captures:0}),devices:async()=>[]};

for(const exhaustedAgain of [false,true])test(`typed output exhaustion ${exhaustedAgain?'fails explicitly after one retry':'retries a shorter complete answer'} without accepting a truncated turn`,{timeout:30000},async()=>{
 const requests=[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;requests.push(JSON.parse(raw));const turn=requests.length;
  const delta=turn===1?{role:'assistant',tool_calls:[{index:0,id:'discover',type:'function',function:{name:'search_context',arguments:'{"query":"generated"}'}}]}:{role:'assistant',content:JSON.stringify({answer:`Completed the generated review. [${record.id}]`,citationIds:[record.id]})};
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:turn===1?'tool_calls':turn===2||exhaustedAgain?'length':'stop'}]})}\n\ndata: [DONE]\n\n`);
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const agent=createAgent({reader,model:'generated',apiKey:'synthetic',baseUrl:`http://127.0.0.1:${provider.address().port}`,maxTokens:65536,timeoutMs:20000});
 try{
  if(exhaustedAgain)await assert.rejects(agent.query({question:'总结我最近都干了啥'}),e=>e instanceof AgentResponseError&&e.reason==='output_limit');
  else {const result=await agent.query({question:'总结我最近都干了啥'});assert.equal(result.citations[0].id,record.id);assert.equal(result.trace.length,1);}
  assert.equal(requests.length,3,'One correction only, including when the truncated text is syntactically valid JSON');
  assert.equal(requests[0].max_tokens,65536);
  const input=JSON.parse(requests[0].messages.find(m=>m.role==='user').content);assert.equal(input.request,'总结我最近都干了啥');assert.equal(input.responseMode,'answer');
  const correction=JSON.parse(requests[2].messages.filter(m=>m.role==='user').at(-1).content);
  assert.equal(correction.responseMode,'answer');assert.equal(correction.outputBudget,65536);assert.match(correction.recovery,/shorter/);assert.match(correction.presentation,/Do not serialize/);
  assert.ok(requests[2].messages.some(m=>m.role==='tool'),'Evidence remains in the same session');
 }finally{await agent.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
});
