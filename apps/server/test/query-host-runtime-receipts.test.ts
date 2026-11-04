import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';

const token='generated-dsh-receipt-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string,baseUrl:string):Config=>({
  dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,
  retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-dsh-model',modelProvider:'custom',
  modelProtocol:'deepseek',modelBaseUrl:baseUrl,apiKey:'generated-unused-key',allowUnauthenticatedLocal:false,
  embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent',agentTimeoutMs:20000,
});

async function until<T>(read:()=>T|undefined,label:string,timeoutMs=20000):Promise<T>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){const value=read();if(value)return value;await delay(25);}
  throw Error('Timed out waiting for '+label);
}

async function fixture(t:import('node:test').TestContext,handler:(res:ServerResponse)=>void){
  const directory=mkdtempSync(join(tmpdir(),'mote-dsh-receipts-'));
  const server:Server=createServer((_request,response)=>handler(response));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const node=await buildApp(config(directory,baseUrl),{backgroundWorker:false});
  t.after(async()=>{
    await node.app.close();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(directory,{recursive:true,force:true});
  });
  const receipts=()=>(node.store.db.prepare('SELECT json FROM model_usage ORDER BY created_at,id').all() as {json:string}[]).map(row=>JSON.parse(row.json) as {id:string;status:string;operation:string});
  const post=(url:string,payload:unknown)=>node.app.inject({method:'POST',url,headers,payload});
  const get=(url:string)=>node.app.inject({url,headers});
  return {node,baseUrl,receipts,post,get};
}

test('a completed DSH run writes one completed receipt',async t=>{
  const f=await fixture(t,response=>writeMessagesResponse(response,{stage:0,text:JSON.stringify({answer:'Generated DSH answer.',citationIds:[]})}));
  const response=await f.post('/api/query',{question:'Generated DSH completion question'});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().answer,'Generated DSH answer.');
  const receipts=f.receipts();
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].status,'completed');
  assert.equal(receipts[0].operation,'query');
});

test('a failed DSH run writes one failed receipt',async t=>{
  const f=await fixture(t,response=>{
    response.writeHead(400,{'content-type':'application/json'});
    response.end(JSON.stringify({error:{type:'invalid_request_error',message:'Generated DSH failure'}}));
  });
  const response=await f.post('/api/query',{question:'Generated DSH failure question'});
  assert.notEqual(response.statusCode,200,response.body);
  const receipts=await until(()=>f.receipts().length?f.receipts():undefined,'the failed DSH receipt');
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].status,'failed');
});

test('a cancelled DSH run keeps one failed receipt without publishing an answer',async t=>{
  let pending:ServerResponse|undefined;
  const f=await fixture(t,response=>{pending=response;});
  const id=randomUUID();
  assert.equal((await f.post('/api/query-runs',{id,input:{question:'Generated DSH cancellation question'}})).statusCode,202);
  await until(()=>pending,'the DSH model request');
  assert.equal((await f.post('/api/query-runs/'+id+'/cancel',{})).statusCode,200);
  const run=await until(()=>{const value=f.node.queryRuns.get(id);return value.status!=='running'?value:undefined;},'the cancelled DSH run');
  assert.equal(run.status,'cancelled');
  assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM conversation_turns WHERE json_extract(json,'$.result') IS NOT NULL").get()!.n,0);
  const receipts=await until(()=>{
    const rows=f.receipts();
    return rows.length&&rows.every(row=>row.status!=='running')?rows:undefined;
  },'the cancelled DSH receipt');
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].status,'failed');
});
