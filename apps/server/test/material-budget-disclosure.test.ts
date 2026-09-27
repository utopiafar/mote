import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {parseAnswer} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

test('real server candidate grants cannot bypass bridge disclosure after a material page shrinks',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-budget-disclosure-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const image=await sharp({create:{width:2,height:2,channels:3,background:'#ddeeff'}}).png().toBuffer();
  const ids=[randomUUID(),randomUUID(),randomUUID()],at='2026-09-24T00:00:00.000Z';
  for(const [index,id] of ids.entries())await store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:index<2?'macos':'import',source:index<2?'screen':'note',capturedAt:at,durationMs:0,ocrText:`Generated original ${index}`,...(index<2?{imageMime:'image/png',imageBase64:image.toString('base64')}:{})});
  const draft:MaterialDraft={id:materialId('screen:generated','budget-page'),kind:'mote.screen-segment',schemaVersion:1,title:'Generated page with original members',origin:{sourceId:'screen:generated',externalId:'budget-page',deviceId:'generated-device',firstAt:at,lastAt:at},
    blocks:[5999,1999,1999].map((length,index)=>({id:`generated-block-${index}`,kind:'text' as const,format:'plain',text:'"'.repeat(length),memberIds:[`member-${index}`]})),
    members:ids.map((id,index)=>({id:`member-${index}`,kind:'capture' as const,ref:`capture:${id}`})),coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const material=materials.publish(draft),archiveReader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);
  const queryContext=new AsyncLocalStorage<object>(),reader=archiveReader.agent({diagnostics,allowQueryImages:()=>true,currentGrantContext:()=>queryContext.getStore()});
  await queryContext.run({},async()=>{
    assert.deepEqual(await reader.evidence({ids:[ids[1]]}),[],'screen is unavailable before a current query source grant');
    const bridge=await startBridge(reader,{question:'Generated budget disclosure check',deviceId:'generated-device'},40);
    try{
      const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
      const catalog=await call('material_catalog',{});assert.equal(catalog.status,200);assert.equal(catalog.body.data.items[0].ref,material.ref);
      const before=bridge.deliveredCharacters,page=await call('material_read',{ref:material.ref,length:10000});
      assert.equal(page.status,200);assert.equal(page.body.data.text.length,5000);assert.equal(page.body.data.textRange.nextOffset,5000);
      assert.deepEqual(page.body.data.originalRefs,[ids[0]]);assert.equal(bridge.trace.at(-1)!.materialPage!.readAttempts,2);
      assert.equal(bridge.deliveredCharacters,before+JSON.stringify(page.body).length);
      assert.deepEqual((await reader.evidence({ids:[ids[1]]})).map(record=>record.id),[ids[1]],'the rejected larger candidate really established the server screen grant');
      assert.equal((await reader.readImage!({id:ids[1]})).mimeType,'image/png','the internal reader grant is sufficient for its own image method, but not the bridge');
      for(const id of ids.slice(1)){
        for(const reference of [id,`capture:${id}`]){
          assert.equal((await call('evidence',{ids:[reference],length:30})).status,400);
          assert.equal((await call('read_image',{id:reference})).status,400);
          assert.equal((await call('read_file_evidence',{id:reference,length:30})).status,400);
          assert.equal((await call('file_chunks',{id:reference})).status,400);
          assert.equal((await call('source_history',{id:reference})).status,400);
        }
        assert.equal(bridge.records.has(id),false);assert.equal(bridge.evidenceDependencies.ids.includes(id),false);
        assert.throws(()=>parseAnswer(JSON.stringify({answer:'Generated omitted citation',citationIds:[id]}),bridge.records),/not retrieved/);
      }
      assert.equal((await call('read_raw',{id:ids[1]})).status,404,'read_raw is not an exposed tool in this production revision');
      assert.equal((await call('read_image',{id:ids[0]})).status,400,'even the accepted original must be expanded before image reading');
      assert.equal((await call('evidence',{ids:[ids[0]],length:30})).status,200);
      const acceptedImage=await call('read_image',{id:ids[0]});assert.equal(acceptedImage.status,200);assert.ok(acceptedImage.body.image);
      bridge.imageDelivery(acceptedImage.body.imageDelivery,true);
      assert.equal(parseAnswer(JSON.stringify({answer:'Generated accepted citation',citationIds:[ids[0]]}),bridge.records).citations[0].id,ids[0]);
      t.diagnostic(JSON.stringify({localPageReads:2,successfulMaterialResults:1,omittedScreenGrantObserved:true,omittedCaptureCount:2,realProviderCalls:0}));
    }finally{await bridge.close();}
  });
  await queryContext.run({},async()=>{
    assert.deepEqual(await reader.evidence({ids:[ids[1]]}),[],'a separate query cannot inherit the preparatory grant');
    await assert.rejects(reader.readImage!({id:ids[1]}),/Image not found/);
  });
});
