import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {materialId,type MaterialDraft} from '../src/materials.js';

const config=(dataDir:string):ConfigurationPlatformOptions=>({path:(dataDir)+'/mote.yaml',privateCredential:{token:'generated-route-owner-token',tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}});

function draft(captureId:string):MaterialDraft{
  return {id:materialId('generated-route-source','item'),kind:'mote.note',schemaVersion:1,title:'Generated route material',
    origin:{sourceId:'generated-route-source',externalId:'item',deviceId:'generated-route-device',firstAt:'2026-11-04T00:00:00.000Z',lastAt:'2026-11-04T00:00:00.000Z'},
    members:[{id:'original',kind:'capture',ref:'capture:'+captureId}],
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated route original',memberIds:['original']}],
    coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
}

test('material and context routes stay plugin-owned and never expose deleted originals',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-material-context-routes-')),options=config(dataDir);
  const node=await buildApp(options,{backgroundWorker:false});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${options.privateCredential!.token}`},captureId=randomUUID();
  await node.store.ingest({id:captureId,deviceId:'generated-route-device',deviceName:'Generated',platform:'import',source:'note',
    capturedAt:'2026-11-04T00:00:00.000Z',durationMs:0,ocrText:'Generated route original'});
  const published=node.materials.publish(draft(captureId));

  const contributions=node.bootstrap.snapshot().contributions.map(item=>item.identity.contributionId);
  for(const id of ['material-retrieval-index','material-context','evidence-context-reader'])assert.ok(contributions.includes(id),`default producer installed ${id}`);
  assert.equal(typeof node.indexer.tick,'function');
  node.materials.setSearchable(published.id,true);
  await node.materials.index!.tick();
  assert.equal(node.materials.get(published.id)?.indexing.state,'indexed','the selected default Indexer consumes a published Material');
  const list=await node.app.inject({url:'/api/materials',headers});assert.equal(list.statusCode,200,list.body);
  assert.deepEqual(Object.keys(list.json()).sort(),['items','nextCursor']);
  assert.ok(list.json().items.some((item:{ref:string})=>item.ref===published.ref));
  const inventory=(await node.app.inject({url:'/api/features',headers})).json();
  assert.ok(inventory.capabilities.some((item:any)=>item.featureId==='mote.materials'&&item.id==='http:GET:/api/materials'),
    'the plugin contribution remains visible through the feature inventory');
  const search=await node.app.inject({url:'/api/context/search?query=Generated',headers});assert.equal(search.statusCode,200,search.body);
  assert.deepEqual(Object.keys(search.json()).sort(),['coverage','items','nextCursor','truncated']);
  assert.ok(search.json().items.length>0);

  node.store.delete(captureId);
  assert.equal((await node.app.inject({url:`/api/materials/${published.id}/read?revision=${published.revision}`,headers})).statusCode,404,
    'a revoked source cannot be read through a retained Material revision');
  const read=await node.app.inject({method:'POST',url:'/api/context/read',headers,payload:{refs:['capture:'+captureId]}});
  assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.json().items,[],'withdrawn original text is not returned through the context cursor');
  await node.featureRoutes.dispose('mote.materials');assert.equal((await node.app.inject({url:'/api/materials',headers})).statusCode,503);
  await node.featureRoutes.dispose('mote.context');assert.equal((await node.app.inject({url:'/api/context/search?query=Generated',headers})).statusCode,503);
});
