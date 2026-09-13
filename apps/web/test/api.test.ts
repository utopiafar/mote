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
