import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi, errorMessage } from '../src/api.js';

test('failed requests retain validated request IDs for cross-service diagnostics', async t => {
  const requestId = 'c919bc95-272d-4094-92a1-7f9c0ae944ca';
  let unauthorized = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({message:'请连接中央节点。',requestId}), {
    status:401, headers:{'Content-Type':'application/json','X-Request-Id':requestId},
  }));
  await assert.rejects(createApi({url:'http://127.0.0.1',token:'synthetic'}, () => unauthorized++).request('/api/status'), error => {
    assert.ok(error instanceof ApiError);assert.equal(error.requestId,requestId);
    assert.match(errorMessage(error),new RegExp(requestId));return true;
  });
  assert.equal(unauthorized,1);
});
test('malformed error fields cannot become a request ID or object error message', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({message:{private:'data'},requestId:'untrusted-header'}),{status:500}));
  await assert.rejects(createApi({url:'http://127.0.0.1',token:'synthetic'}).request('/api/status'), error => {
    assert.ok(error instanceof ApiError);assert.equal(error.requestId,undefined);
    assert.equal(errorMessage(error),'请求未完成（500）');return true;
  });
});
test('proxy HTML failures preserve actionable status without rendering its body or disconnecting', async t => {
  let unauthorized = 0;
  const api = createApi({url:'https://fixture.example.com',token:'synthetic'}, () => unauthorized++);
  for (const status of [413, 502, 524]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response('<html>PRIVATE_PROXY_BODY<script>untrusted()</script></html>', {status, headers:{'Content-Type':'text/html'}}));
    await assert.rejects(api.request('/api/query'), error => {
      assert.ok(error instanceof ApiError); assert.equal(error.status,status);
      assert.match(error.message,new RegExp(String(status))); assert.equal(error.message.includes('PRIVATE_PROXY_BODY'),false);
      return true;
    });
    mock.mock.restore();
  }
  assert.equal(unauthorized,0);
});

test('a delayed 401 from a previous connection cannot disconnect the new node or a reconnected session', async t => {
  let generation=1,unauthorized=0,deliver: (response:Response)=>void=()=>{};
  t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>{deliver=resolve;}));
  const previous=generation;
  const api=createApi({url:'https://old.example',token:'synthetic'},()=>unauthorized++,()=>generation===previous);
  const pending=api.request('/api/status');
  generation++;
  deliver(new Response('{}',{status:401}));
  await assert.rejects(pending,ApiError);assert.equal(unauthorized,0);
  const current=createApi({url:'https://new.example',token:'synthetic'},()=>unauthorized++,()=>generation===2);
  const currentRequest=current.request('/api/status');deliver(new Response('{}',{status:401}));
  await assert.rejects(currentRequest,ApiError);assert.equal(unauthorized,1);
});

test('only model operations use the node deadline plus transport allowance; ordinary requests keep their deadline', async t => {
  const durations:number[]=[],signals:AbortSignal[]=[];
  t.mock.method(AbortSignal,'timeout',(ms:number)=>{durations.push(ms);return new AbortController().signal;});
  t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{signals.push(init!.signal!);return new Response('{}');});
  const api=createApi({url:'https://fixture.example',token:'synthetic'});
  api.setAgentTimeout(300000);
  for(const path of ['/api/query','/api/insights','/api/memories/extract']) await api.request(path,{method:'POST'});
  await api.request('/api/insights'); await api.request('/api/captures',{method:'POST',body:'{}'}); await api.request('/api/query-other',{method:'POST'});
  assert.deepEqual(durations,[360000,360000,360000,180000,180000,180000]);
  api.setAgentTimeout(600000);const controller=new AbortController();
  await api.request('/api/query',{method:'POST',signal:controller.signal});
  assert.equal(durations.at(-1),660000);assert.equal(signals.at(-1)!.aborted,false);
  controller.abort();assert.equal(signals.at(-1)!.aborted,true,'User navigation still cancels a long model request');
  for(const value of [undefined,0,Infinity,600001,5000.5]){api.setAgentTimeout(value);await api.request('/api/query',{method:'POST'});assert.equal(durations.at(-1),180000);}
  const next=createApi({url:'https://next.example',token:'synthetic-next'});
  api.setAgentTimeout(600000);await next.request('/api/query',{method:'POST'});assert.equal(durations.at(-1),180000,'New connections do not inherit former server budgets');
});
