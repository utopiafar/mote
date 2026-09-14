import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { boundedModelFetch } from '../src/plugin.mjs';
import { createAgent, parseAnswer, AgentResponseError } from '../dist/index.js';

const bridge='http://127.0.0.1:1';

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

test('body limits cover error responses and cumulative model turns without altering request transport policy', async () => {
  const seen=[], init={method:'POST',redirect:'follow',credentials:'include',headers:{Authorization:'Bearer synthetic'},body:'generated'};
  const transport=boundedModelFetch(async(input,options)=>{seen.push([input,options]);return new Response('x'.repeat(80),{status:500,headers:{'Content-Type':'text/plain'}});},bridge,128);
  const first=await transport('http://synthetic-provider',init);
  assert.equal(first.status,500);assert.equal((await first.text()).length,80);
  assert.equal(seen[0][1],init);
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
  const reader={search:async()=>[],timeline:async()=>[],evidence:async()=>[],activity:async()=>({}),devices:async()=>[]};
  const agent=createAgent({reader,baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,model:'synthetic',apiKey:'synthetic',timeoutMs:8000});
  const start=Date.now();
  try {
    await assert.rejects(agent.query({question:'Generated stream resource fixture'}));
    assert.equal(requests,1,'Retry handling cannot restart an exhausted byte budget');
    assert.ok(closedAt>start&&closedAt-start<7000,'The byte budget cancels the source before deadline cleanup');
  } finally {
    await agent.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  }
});
