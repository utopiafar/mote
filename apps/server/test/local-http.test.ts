import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {requestLocalJson} from '../src/local-http.js';

test('direct local health requests remain bounded, abortable and reject redirects before following them',async t=>{
  let redirects=0;
  const server=createServer((req,res)=>{
    req.resume();
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/destination'});res.end();return;}
    if(req.url==='/destination'){redirects++;res.end('{}');return;}
    if(req.url==='/large'){res.end(JSON.stringify({generated:'x'.repeat(5000)}));return;}
    if(req.url==='/held')return;
    if(req.url==='/missing-offline'){res.end('{}');return;}
    res.end(JSON.stringify({execution:'local'}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  assert.deepEqual(await requestLocalJson(endpoint+'/health',{signal:AbortSignal.timeout(1000),limit:4096}),{execution:'local'});
  await assert.rejects(requestLocalJson(endpoint+'/large',{signal:AbortSignal.timeout(1000),limit:4096}),/exceeds limit/);
  await assert.rejects(requestLocalJson(endpoint+'/redirect',{signal:AbortSignal.timeout(1000),limit:4096}));assert.equal(redirects,0);
  await assert.rejects(requestLocalJson(endpoint+'/held',{signal:AbortSignal.timeout(30),limit:4096}),{name:'AbortError'});
  await assert.rejects(requestLocalJson(endpoint+'/missing-offline',{signal:AbortSignal.timeout(1000),requireOfflineExecution:true}),/did not confirm offline execution/);
  assert.throws(()=>requestLocalJson('https://worker.fixture.invalid/health',{signal:AbortSignal.timeout(1000)}),/loopback service/);
});
