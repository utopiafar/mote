import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('Memory jobs paginate the whole queue with a stable tie-breaker and bounded summaries',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-page-')),token='generated-pagination-token';
  const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'https://generated.invalid',apiKey:'generated',embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',allowUnauthenticatedLocal:false};
  const node=await buildApp(config,{agent:{configured:true,close:async()=>{},query:async()=>{throw Error('This fixture must not call a model');}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const evidenceId=randomUUID();
  await node.store.ingest({id:evidenceId,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-09-20T00:00:00Z',durationMs:0,ocrText:'Generated pagination evidence'});
  const ids=Array.from({length:67},()=>node.memoryPipeline.create({evidenceIds:[evidenceId]}).id);
  const at='2026-09-21T00:00:00.000Z';
  node.store.db.prepare('UPDATE memory_jobs SET created_at=?').run(at);
  const headers={authorization:'Bearer '+token},seen:string[]=[];
  let cursor:string|null=null;
  do{
    const response=await node.app.inject({url:'/api/memory-jobs?limit=11'+(cursor?'&cursor='+encodeURIComponent(cursor):''),headers});
    assert.equal(response.statusCode,200,response.body);
    const page=response.json();assert.ok(page.items.length<=11);
    for(const item of page.items){assert.deepEqual(item.evidenceIds,[]);assert.deepEqual(item.memoryIds,[]);assert.equal(item.materialInputs,undefined);seen.push(item.id);}
    cursor=page.nextCursor;
  }while(cursor);
  assert.deepEqual(seen,[...ids].sort().reverse());assert.equal(new Set(seen).size,67);
  const first=node.memoryPipeline.page({limit:10});
  const newer=node.memoryPipeline.create({evidenceIds:[evidenceId]}).id;
  const second=node.memoryPipeline.page({limit:10,cursor:first.nextCursor!});
  assert.ok(!second.items.some(item=>first.items.some(prior=>prior.id===item.id)||item.id===newer));
  assert.equal((await node.app.inject({url:'/api/memory-jobs',headers})).json().items.length,30);
  for(const query of ['limit=101','limit=0','cursor=malformed','unknown=true'])assert.equal((await node.app.inject({url:'/api/memory-jobs?'+query,headers})).statusCode,400,query);
  assert.equal((await node.app.inject({url:'/api/memory-jobs'})).statusCode,401);
});
