import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { boundedModelFetch } from '../dist/plugin.mjs';
import { createAgent, parseAnswer, AgentResponseError } from '../dist/index.js';

const bridge='http://127.0.0.1:1';

test('native DeepSeek rejects Files I/O before admission and preserves inline Messages',async()=>{
  for(const baseUrl of ['https://fixture.invalid/anthropic','https://fixture.invalid/v1']){
    let fetches=0,admissions=0;
    const transport=boundedModelFetch(async(_input,init)=>{fetches++;assert.equal(typeof init.body,'string');return Response.json({ok:true});},bridge,1024,{protocol:'deepseek',baseUrl},undefined,async()=>{admissions++;});
    const files=baseUrl+(baseUrl.endsWith('/v1')?'/files':'/v1/files');
    await assert.rejects(transport(files,{method:'POST',body:new FormData()}),/inline/);
    for(const method of ['GET','DELETE'])await assert.rejects(transport(files+'/generated-id',{method}),/destination/);
    assert.equal(fetches,0);assert.equal(admissions,0);
    const messages=baseUrl+(baseUrl.endsWith('/v1')?'/messages':'/v1/messages');
    await (await transport(messages,{method:'POST',body:JSON.stringify({messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'generated'}}]}]})})).text();
    assert.equal(fetches,1);assert.equal(admissions,1);
    await assert.rejects(transport('https://other.invalid/v1/messages',{method:'POST',body:'{}'}),/destination/);
    await assert.rejects(transport(baseUrl+'/unexpected',{method:'POST',body:'{}'}),/destination/);
    assert.equal(fetches,1);
  }
});

test('native DeepSeek strips upload metadata and auto effort, then honors explicit owner parameters',async()=>{
  let body;
  const transport=boundedModelFetch(async(_input,init)=>{body=JSON.parse(init.body);return Response.json({ok:true});},bridge,1024,{protocol:'deepseek',baseUrl:'https://fixture.invalid/v1',reasoningEffort:'auto',extraBody:{thinking:{type:'enabled'},output_config:{effort:'max'},dsh_session_log:'generated',dsh_plugin_packages:['generated']}});
  await (await transport('https://fixture.invalid/v1/messages',{method:'POST',body:JSON.stringify({thinking:{type:'disabled'},output_config:{effort:'high',format:'generated'},dsh_session_log:{private:'generated'},dsh_plugin_packages:['generated'],messages:[]})})).text();
  assert.equal(body.dsh_session_log,undefined);assert.equal(body.dsh_plugin_packages,undefined);
  assert.deepEqual(body.thinking,{type:'enabled'});assert.deepEqual(body.output_config,{effort:'max',format:'generated'});
});

test('oversized unframed streams are canceled before SDK parsing and retries cannot restart the flood', async () => {
  let canceled=false,fetches=0,reads=0;
  const transport=boundedModelFetch(async()=>{
    fetches++;
    return new Response(new ReadableStream({
      pull(controller){reads++;controller.enqueue(new Uint8Array(64));},
      cancel(){canceled=true;},
    }),{headers:{'Content-Type':'text/event-stream'}});
  },bridge,128);
  const response=await transport('http://synthetic-provider/v1/chat/completions');
  await assert.rejects(response.text(),/byte budget/);
  assert.equal(canceled,true);assert.ok(reads<=4);
  await assert.rejects(transport('http://synthetic-provider/v1/chat/completions'),/byte budget/);
  assert.equal(fetches,1);
});

test('body limits cover error responses and cumulative turns while forbidding redirects', async () => {
  const seen=[], init={method:'POST',redirect:'follow',credentials:'include',headers:{Authorization:'Bearer synthetic'},body:'generated'};
  const transport=boundedModelFetch(async(input,options)=>{seen.push([input,options]);return new Response('x'.repeat(80),{status:500,headers:{'Content-Type':'text/plain'}});},bridge,128);
  const first=await transport('http://synthetic-provider',init);
  assert.equal(first.status,500);assert.equal((await first.text()).length,80);
  assert.deepEqual(seen[0][1],{...init,redirect:'manual'});
  const second=await transport('http://synthetic-provider',init);
  await assert.rejects(second.text(),/byte budget/);
});

test('authenticated bridge reads keep their existing independent evidence budget', async () => {
  const transport=boundedModelFetch(async()=>new Response('x'.repeat(200)),bridge,128);
  assert.equal((await (await transport(bridge+'/timeline')).text()).length,200);
  await assert.rejects((await transport(bridge+'.attacker.invalid/timeline')).text(),/byte budget/);
});

test('oversized final JSON is rejected before normalization and Markdown parsing', () => {
  assert.throws(()=>parseAnswer(JSON.stringify({answer:'> '.repeat(500001),citationIds:[]}),new Map()),AgentResponseError);
  assert.equal(parseAnswer('{"answer":"Generated answer.","citationIds":[]}',new Map()).answer,'Generated answer.');
});

test('real Harness cancels an unbounded synthetic SSE line before its query deadline', {timeout:30000}, async () => {
  let requests=0,closedAt=0;
  const provider=createServer(async(req,res)=>{
    for await(const _chunk of req){}
    requests++;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    let written=0,closed=false;
    res.on('close',()=>{closed=true;closedAt=Date.now();});
    const chunk=Buffer.alloc(64*1024,120);
    const pump=()=>{
      while(!closed&&written<33*1024*1024){
        written+=chunk.length;
        if(!res.write(chunk)){res.once('drain',pump);return;}
      }
      // No line ending or [DONE]: a time limit alone keeps this buffered until timeout.
    };
    pump();
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const reader={search:async()=>[],timeline:async()=>({items:([]),nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]};
  const agent=createAgent({reader,baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'synthetic',apiKey:'synthetic',agentTimeoutMs:8000});
  const start=Date.now();
  try {
    await assert.rejects(agent.query({question:'Generated stream resource fixture'}));
    assert.equal(requests,1,'Retry handling cannot restart an exhausted byte budget');
    assert.ok(closedAt>start&&closedAt-start<7000,'The byte budget cancels the source before deadline cleanup');
  } finally {
    await agent.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  }
});
