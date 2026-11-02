import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {buildApp} from '../src/app.js';
import {mcpContext} from '../src/connectors/mcp-context.js';
import type {ConnectorContext} from '../src/connectors/types.js';
import type {EvidenceReader} from '../src/evidence-reader.js';
import type {Config} from '../src/config.js';

const note=()=>({id:randomUUID(),deviceId:'generated-evidence-device',deviceName:'Generated evidence device',platform:'android',capturedAt:'2026-11-03T00:00:00.000Z',text:'Generated evidence-context note'});

test('roots serves context reads from one evidence factory, MCP consumes it, and close disposes it',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-roots-evidence-'));
  const config:Config={dataDir,token:'generated-roots-evidence-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in roots evidence fixture');},close:async()=>{}}});
  t.after(async()=>{try{await node.app.close();}catch{}rmSync(dataDir,{recursive:true,force:true});});
  const reader=node.evidenceContext.assembly.reader;
  assert.equal(node.featureServices.evidenceReader,reader,'features must read through the factory reader');
  assert.equal(node.featureServices.contextTrees,node.evidenceContext.assembly.contextTrees,'one context registry, no duplicate');
  assert.equal(node.evidenceContext.disposed,false);
  const headers={authorization:`Bearer ${config.token}`};
  assert.equal((await node.app.inject({method:'POST',url:'/api/notes',headers,payload:note()})).statusCode,201);
  const index=await node.app.inject({url:'/api/context-index',headers});
  assert.equal(index.statusCode,200,index.body);
  const segments=await node.app.inject({url:'/api/context/segments',headers});
  assert.equal(segments.statusCode,200,segments.body);
  // MCP must consume the injected reader: a sentinel proves no fallback reader
  // is constructed inside the connector composition.
  const sentinel=new Proxy({},{get:()=>()=>({sentinel:true})}) as unknown as EvidenceReader;
  const connectorContext={store:node.store,sources:node.sources,evidenceReader:sentinel,config:{dataDir,token:config.token,allowedOrigins:[]}} as ConnectorContext;
  assert.deepEqual((mcpContext(connectorContext).read.reader.queryPage as (input?:unknown)=>{sentinel:boolean})(),{sentinel:true});
  const view=node.evidenceContext.agent({diagnostics:node.diagnostics});
  const catalog=node.evidenceContext.ports.contextTreesRead.catalog;
  await node.app.close();
  assert.equal(node.evidenceContext.disposed,true,'close must dispose the evidence factory');
  assert.throws(()=>catalog(),(error:any)=>error?.statusCode===503,'a saved port must reject after disposal');
  assert.throws(()=>view.evidence([] as never,undefined),(error:any)=>error?.statusCode===503,'a saved agent view must reject after disposal');
});

test('an accepted read finishes before close disposes the evidence factory',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-roots-read-drain-'));
  const config:Config={dataDir,token:'generated-roots-read-drain-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in roots read drain fixture');},close:async()=>{}}});
  t.after(async()=>{try{await node.app.close();}catch{}rmSync(dataDir,{recursive:true,force:true});});
  let entered!:()=>void;const enteredRead=new Promise<void>(resolve=>{entered=resolve;});
  node.app.get('/api/roots-slow-read',async()=>{
    entered();
    await new Promise(resolve=>setTimeout(resolve,150));
    return {disposedDuringRead:node.evidenceContext.disposed,catalog:node.evidenceContext.ports.contextTreesRead.catalog()};
  });
  await node.app.listen({host:'127.0.0.1',port:0});
  const {port}=node.app.server.address() as AddressInfo;
  const read=new Promise<{status:number;body:any}>((resolve,reject)=>{
    const request=http.request({host:'127.0.0.1',port,path:'/api/roots-slow-read',headers:{authorization:`Bearer ${config.token}`,connection:'close'}},response=>{
      let text='';response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode??0,body:JSON.parse(text)}));
    });
    request.on('error',reject);request.end();
  });
  await enteredRead;
  const closing=node.app.close();
  const response=await read;
  assert.equal(response.status,200,'the accepted read must not be cut by shutdown');
  assert.equal(response.body.disposedDuringRead,false,'disposal must wait for accepted reads');
  await closing;
  assert.equal(node.evidenceContext.disposed,true);
});
