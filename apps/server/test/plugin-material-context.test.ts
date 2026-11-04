import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId,type MaterialDraft} from '../src/materials.js';

const config=(dataDir:string):Config=>({dataDir,token:'generated-route-owner-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,
  maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'});

function draft(captureId:string):MaterialDraft{
  return {id:materialId('generated-route-source','item'),kind:'mote.note',schemaVersion:1,title:'Generated route material',
    origin:{sourceId:'generated-route-source',externalId:'item',deviceId:'generated-route-device',firstAt:'2026-11-04T00:00:00.000Z',lastAt:'2026-11-04T00:00:00.000Z'},
    members:[{id:'original',kind:'capture',ref:'capture:'+captureId}],
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated route original',memberIds:['original']}],
    coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
}

test('material and context routes stay plugin-owned and never expose deleted originals',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-material-context-routes-'));
  const node=await buildApp(config(dataDir),{backgroundWorker:false});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config(dataDir).token}`},captureId=randomUUID();
  await node.store.ingest({id:captureId,deviceId:'generated-route-device',deviceName:'Generated',platform:'import',source:'note',
    capturedAt:'2026-11-04T00:00:00.000Z',durationMs:0,ocrText:'Generated route original'});
  const published=node.materials.publish(draft(captureId));

  const list=await node.app.inject({url:'/api/materials',headers});assert.equal(list.statusCode,200,list.body);
  assert.deepEqual(Object.keys(list.json()).sort(),['items','nextCursor']);
  assert.ok(list.json().items.some((item:{ref:string})=>item.ref===published.ref));
  const inventory=(await node.app.inject({url:'/api/features',headers})).json();
  assert.ok(inventory.capabilities.some((item:any)=>item.featureId==='mote.material-repository'&&item.id==='material-repository'&&item.state==='active'),
    'the host plugin contribution remains visible through the feature inventory');
  const search=await node.app.inject({url:'/api/context/search?query=Generated',headers});assert.equal(search.statusCode,200,search.body);
  assert.deepEqual(Object.keys(search.json()).sort(),['coverage','items','nextCursor','truncated']);
  assert.ok(search.json().items.length>0);

  node.store.delete(captureId);
  assert.equal((await node.app.inject({url:`/api/materials/${published.id}/read?revision=${published.revision}`,headers})).statusCode,404,
    'a revoked source cannot be read through a retained Material revision');
  const read=await node.app.inject({method:'POST',url:'/api/context/read',headers,payload:{refs:['capture:'+captureId]}});
  assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.json().items,[],'withdrawn original text is not returned through the context cursor');
  await node.featureHost.dispose('mote.materials');assert.equal((await node.app.inject({url:'/api/materials',headers})).statusCode,503);
  await node.featureHost.dispose('mote.context');assert.equal((await node.app.inject({url:'/api/context/search?query=Generated',headers})).statusCode,503);
});
