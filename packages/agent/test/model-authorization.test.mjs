import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createServer} from 'node:http';
import {createAgent} from '../dist/index.js';
import {ProviderFailure} from '@mote/shared';
import {boundedModelFetch} from '../dist/plugin.mjs';

test('every outbound model attempt is authorized before transport, including repeated turns',async()=>{
 let calls=0,admissions=0;const fetch=boundedModelFetch(async()=>{calls++;return new Response('{}');},'http://bridge',undefined,undefined,undefined,()=>{if(++admissions===2)throw Error('generated evidence authorization denied');});
 await fetch('http://provider',{method:'POST',body:'{"model":"fixture"}'});
 await assert.rejects(fetch('http://provider',{method:'POST',body:'{"model":"fixture"}'}),/authorization denied/);assert.equal(admissions,2);assert.equal(calls,1);
});
test('real Harness authorization preserves host scope and rejects before sending evidence',async()=>{
 let calls=0,admissions=0;const scope=new AsyncLocalStorage();
 const server=createServer((_req,res)=>{calls++;res.writeHead(500).end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const agent=createAgent({reader:{search:async()=>[],timeline:async()=>({items:([]),nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]},model:'fixture',apiKey:'generated',protocol:'openai-completions',baseUrl:'http://127.0.0.1:'+server.address().port,authorizeModelRequest:()=>{admissions++;assert.equal(scope.getStore(),'generated-operation');throw new ProviderFailure({category:'blocked',code:'context_evidence_restricted'});}});
 try{await assert.rejects(scope.run('generated-operation',()=>agent.query({question:'Generated authorization fixture'})),error=>error.details?.code==='context_evidence_restricted');assert.equal(admissions,1);assert.equal(calls,0);}finally{await agent.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
