import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {DeepSeekHarness,RequestTimeoutError} from '@deepseek-ai/dsh-sdk-client';
import {createAgent,AgentTimeoutError,AgentResponseError,AgentProviderError} from '../dist/index.js';

const reader={search:async()=>[],timeline:async()=>[],evidence:async()=>[],activity:async()=>({captures:0}),devices:async()=>[]};
const options={reader,model:'synthetic-model',apiKey:'synthetic-test-key',baseUrl:'http://127.0.0.1:9/v1'};
const marker='SYNTHETIC_PRIVATE_STDERR_OR_PROVIDER_TEXT';

test('a real local stalled provider reaches the explicit deadline and its runtime is closed', {timeout:30000},async()=>{
  let requests=0;const sockets=new Set();
  const provider=createServer(async(req,res)=>{for await(const _chunk of req){}requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();});
  provider.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const agent=createAgent({...options,baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,timeoutMs:8000});
  try{
    const started=Date.now();await assert.rejects(agent.query({question:'Synthetic stalled transport fixture'}),error=>error instanceof AgentTimeoutError&&error.statusCode===504);
    assert.ok(Date.now()-started>=7900);assert.ok(requests>0,'The real pinned runtime must reach the synthetic HTTP provider');
    await agent.close();for(let i=0;i<20&&sockets.size;i++)await delay(25);
    assert.equal(sockets.size,0,'Timeout cleanup closes the child-owned response stream');
    // A deadline is observable. This fixture does not establish the cause of a real provider delay.
  }finally{await agent.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
});

test('only the SDK timeout class converts, without preserving its stderr or provider text',async t=>{
  t.mock.method(DeepSeekHarness.prototype,'run',async()=>{throw new RequestTimeoutError(marker);});
  const agent=createAgent(options);t.after(()=>agent.close());
  await assert.rejects(agent.query({question:'Synthetic typed SDK timeout'}),error=>error instanceof AgentTimeoutError&&error.statusCode===504&&!String(error).includes(marker));
});

test('deadline remains primary when cleanup fails, and cleanup is still awaited',async t=>{
  let cleaned=false;
  t.mock.method(DeepSeekHarness.prototype,'run',async()=>new Promise(()=>{}));
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{await delay(15);cleaned=true;throw new Error(marker);});
  const agent=createAgent({...options,timeoutMs:10});t.after(()=>agent.close());
  await assert.rejects(agent.query({question:'Synthetic deadline and cleanup failure'}),error=>error instanceof AgentTimeoutError&&!String(error).includes(marker));
  assert.equal(cleaned,true);
});

test('lookalike timeouts are sanitized as provider failures and validation remains primary during cleanup errors',async t=>{
  const primary=new AgentResponseError('Synthetic invalid final JSON'),fake=Object.assign(new Error('Request timed out '+marker),{name:'RequestTimeoutError'});
  let next=primary;t.mock.method(DeepSeekHarness.prototype,'run',async()=>{throw next;});
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{throw new Error('Synthetic cleanup failed');});
  const agent=createAgent(options);t.after(()=>agent.close());
  await assert.rejects(agent.query({question:'Synthetic invalid output'}),error=>error===primary&&error.statusCode===502);
  next=fake;await assert.rejects(agent.query({question:'Synthetic lookalike text'}),error=>error instanceof AgentProviderError&&!(error instanceof AgentTimeoutError)&&!String(error).includes(marker));
});
