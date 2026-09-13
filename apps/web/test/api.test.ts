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
