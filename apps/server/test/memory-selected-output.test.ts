import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {materialId,type MaterialDraft} from '../src/materials.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';

test('owner-selected OCR and composed originals reach manual Memory without adopting automatic source defaults',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-selected-output-')),token='generated-selection-token';
 const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'https://generated.invalid',apiKey:'generated',embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',allowUnauthenticatedLocal:false};
 const calls:QueryInput[]=[];
 const node=await buildApp(config,{createModelAgent:async()=>({configured:true,close:async()=>{},query:async input=>{calls.push(input);return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};}})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.sources.register({id:'generated-selection',name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
 const raw=(await node.sources.upsert('generated-selection',{externalId:'parent',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated parent.'})).id;
 const draft:MaterialDraft={id:materialId('generated-selection','composed'),kind:'mote.message',schemaVersion:1,title:'Generated composite',origin:{sourceId:'generated-selection',externalId:'composed',deviceId:'generated-device'},members:[{id:'parent',kind:'capture',ref:'capture:'+raw}],
  blocks:[{id:'body',kind:'text',format:'plain',text:'Generated page structure.',memberIds:['parent']},{id:'ocr',kind:'text',format:'plain',text:'Generated exact OCR original.',memberIds:['parent']},{id:'vision',kind:'text',format:'plain',text:'Generated model interpretation, not owner testimony.',memberIds:['parent']}],
  artifacts:[{key:'source-body',state:'ready',blockIds:['body']},{key:'attachment/generated/text',state:'ready',blockIds:['ocr']},{key:'attachment/generated/understanding',state:'ready',blockIds:['vision']},{key:'transcript',state:'pending',blockIds:[]}],coverage:{state:'partial',reason:'processing_pending'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
 const material=node.materials.publish(draft);
 node.sourcePipelines.memoryWork.observe(material.id,['source-body','attachment/generated/understanding'],{inputKey:raw,change:'rebuild',automatic:false});
 const body=node.materials.input(material.ref,['source-body'])!.evidenceIds[0],ocr=node.materials.input(material.ref,['attachment/generated/text'])!.evidenceIds[0],vision=node.materials.input(material.ref,['attachment/generated/understanding'])!.evidenceIds[0];
 const recipe={id:'mote.personal-memory',version:'2'},headers={authorization:'Bearer '+token};
 const grants=node.store.db.prepare('SELECT source_id,input_key,scope,job_id FROM memory_input_authorizations ORDER BY rowid').all();
 for(const ids of [[ocr],[body],[body,ocr,vision]]){
  const before=calls.length,response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{recipes:[recipe],evidenceIds:ids}});
  assert.equal(response.statusCode,202,response.body);
  const job=response.json(),done=await node.memoryPipeline.run(job.id);
  assert.equal(done.status,'completed');assert.deepEqual(new Set(done.evidenceIds),new Set(ids));
  assert.ok(calls.slice(before).some(input=>JSON.stringify([...input.evidenceIds??[]].sort())===JSON.stringify([...ids].sort())),'all and only explicitly selected originals are delivered');
  assert.ok(done.materialInputs?.every(pin=>!pin.required.includes('transcript')),'unselected pending output cannot block the selected ready originals');
 }
 assert.deepEqual(node.store.db.prepare('SELECT source_id,input_key,scope,job_id FROM memory_input_authorizations ORDER BY rowid').all(),grants,'manual selection neither renews nor consumes automatic receipts');
 const explicit={id:'generated.body-policy',version:'1'};
 node.memoryPipeline.strategies.registerRecipe({...explicit,requires:['source-body'],extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:'mote.personal-review',version:'2'}});
 const restricted=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{recipes:[explicit],evidenceIds:[body,ocr]}});
 assert.equal(restricted.statusCode,202,restricted.body);
 assert.deepEqual((await node.memoryPipeline.run(restricted.json().id)).evidenceIds,[body],'explicit recipe requirements retain their own policy');
 assert.deepEqual(node.sourcePipelines.memoryWork.sourceRequirements(material.ref),['source-body','attachment/generated/understanding'],'automatic source scope is unchanged');
 const unauthorized=await node.app.inject({method:'POST',url:'/api/memory-jobs',payload:{recipes:[recipe],evidenceIds:[ocr]}});
 assert.equal(unauthorized.statusCode,401);
 const stale=node.materials.publish({...draft,title:'Replaced custom revision'},{expectedRevision:material.revision});
 assert.notEqual(stale.ref,material.ref);
 const old=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{recipes:[recipe],evidenceIds:[ocr]}});
 assert.equal(old.statusCode,409,old.body);
});
