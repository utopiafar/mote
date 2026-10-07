import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId,type MaterialDraft} from '../src/materials.js';
import {Store} from '../src/store.js';
import {MaterialStore} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';

const at='2026-10-07T01:00:00.000Z';
function formal(sourceId:string,externalId:string):MaterialDraft{return {id:materialId(sourceId,externalId),kind:'fixture.document',schemaVersion:1,title:'Generated '+externalId,origin:{sourceId,externalId,firstAt:at,lastAt:at},blocks:[{id:'body',kind:'text',format:'plain',text:'Generated body',memberIds:['archive']},{id:'extra',kind:'text',format:'plain',text:'Do not disclose unrelated product',memberIds:['archive']}],members:[{id:'archive',kind:'archive',ref:'archive:'+createHash('sha256').update(JSON.stringify([sourceId,externalId])).digest('hex')}],coverage:{state:'partial'},artifacts:[{key:'body',state:'ready',revision:'body-v1',blockIds:['body']},{key:'extra',state:'pending'}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};}
function fixture(t:import('node:test').TestContext,limits:ConstructorParameters<typeof ProcessingRuntime>[2]={}){const directory=mkdtempSync(join(tmpdir(),'mote-library-products-')),store=new Store(directory),materials=new MaterialStore(store),runtime=new ProcessingRuntime(store,[],limits,Date.now,undefined,materials);t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});return {store,materials,runtime};}

test('a deployed namespaced pack synchronizes, executes its flow, exposes one logical item and consumes an opted-in product',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-library-pack-'));
 const config:Config={dataDir:directory,token:'generated-fixture-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',backendPluginModules:[fileURLToPath(new URL('../../../examples/plugins/journal-pack.mjs',import.meta.url))],connectors:{directory:join(directory,'connectors'),modules:[fileURLToPath(new URL('../../../examples/connectors/journal-connector.mjs',import.meta.url))],mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[],googleClientId:'',googleClientSecret:'',googleRedirectUri:'',syncIntervalMs:900000,allowLocalMcp:false}};
 const node=await buildApp(config,{backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.token,'x-mote-ingress-version':'2'};
 const request=async(url:string,method:'GET'|'POST'|'PUT'='GET',payload?:unknown)=>{const result=await node.app.inject({url,method,headers,payload});assert.equal(result.statusCode,200,result.body);return result.json();};
 assert.equal((await node.app.inject('/api/library/catalog')).statusCode,401);
 await request('/api/sources','POST',{id:'fixture-journal',name:'Generated journal',kind:'fixture.journal',deviceId:'fixture-device',platform:'import'});
 await request('/api/source-pipelines/fixture-journal','PUT',{consumers:['fixture.journal-statistics'],memory:false});
 await request('/api/sources/fixture-journal/items/batch','POST',{items:[1,2].map(index=>({externalId:'entry-'+index,revision:'1',observedAt:at,title:'Generated entry',kind:'message',layer:'original',text:'Generated entry '+index}))});
 assert.equal((await request('/api/library/catalog')).items.length,0,'a receipt is not a published material');
 await node.sourcePipelines.tick();await node.featureServices.workflows.tick();await node.featureServices.workflows.tick();
 const catalog=await request('/api/library/catalog');assert.equal(catalog.items.length,1);assert.equal(catalog.items[0].kind,'fixture.journal');assert.equal(catalog.types.find((type:any)=>type.kind==='fixture.journal').card,'fixture.journal-card');assert.equal(catalog.sources[0].label,'Generated journal');
 assert.equal((await request('/api/library/catalog?sourceId=other')).items.length,0);
 const jobs=node.featureServices.workflows.view().jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].state,'succeeded');assert.ok(jobs[0].products?.statistics);
 const output=node.store.archive.get(jobs[0].outputs[0])!;assert.equal(output.metadata.productKey,'statistics');assert.equal(output.text,String('Generated entry 1\nGenerated entry 2\n'.length));assert.ok(output.materialInputs?.every(input=>input.ref===catalog.items[0].ref));
 const draft=node.materials.get(catalog.items[0].ref)!;assert.ok(draft.artifacts?.some(artifact=>artifact.key==='counts'),'registered aggregation reaches publication');
 assert.equal((await request('/api/library/catalog')).items.length,1,'consumers do not duplicate formal objects');
 const processor=node.featureServices.workflows.registry.list()[0];assert.ok(processor);
 assert.equal(node.featureServices.workflows.consumers.list().length,1);
 const before=node.store.db.prepare('SELECT generation FROM source_pipeline_work').all();
 await request('/api/source-pipelines/fixture-journal','PUT',{consumers:[],memory:false});
 await request('/api/source-pipelines/fixture-journal','PUT',{consumers:['fixture.journal-statistics'],memory:false});
 assert.deepEqual(node.store.db.prepare('SELECT generation FROM source_pipeline_work').all(),before,'consumer configuration alone cannot silently rebuild historical source groups');
});

test('named products expose only their blocks and independent consumers do not wait for unrelated products',async t=>{
 const {store,materials,runtime}=fixture(t),record=materials.publish(formal('fixture-source','one'));
 runtime.registry.register({id:'fixture.body',version:'1',lane:'extract',deterministic:true,produces:[{key:'copy',kind:'fixture.copy'}],async process(input){assert.deepEqual(input.observations,[]);assert.equal(input.materials.map(page=>page.text).join(''),'Generated body\n');return [{kind:'fixture.copy',text:'Generated body',metadata:{productKey:'copy'}}];}});
 const job=runtime.enqueue([{name:'body',processor:'fixture.body',productInputs:[{authority:'material',ref:record.ref,key:'body'}]}]).body;
 assert.throws(()=>runtime.enqueue([{name:'missing',processor:'fixture.body',productInputs:[{authority:'material',ref:record.ref,key:'extra'}]}]),{statusCode:409});
 await runtime.tick();assert.equal(runtime.engine.get(job)?.state,'succeeded');const artifact=runtime.view().jobs[0].outputs[0];assert.ok(store.archive.get(artifact));
 assert.equal(runtime.view().jobs[0].products?.copy,artifact);
 materials.publish({...formal('fixture-source','one'),blocks:[{id:'body',kind:'text',format:'plain',text:'Changed body',memberIds:['archive']}] ,artifacts:[{key:'body',state:'ready',revision:'v2',blockIds:['body']}]},{expectedRevision:record.revision});
 assert.equal(store.archive.get(artifact),undefined,'named output keeps original deletion/revision lineage');
});

test('same-version reinstall cannot commit an old running processor, even when the object is reused',async t=>{
 const {materials,runtime}=fixture(t),record=materials.publish(formal('fixture-source','race'));
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const processor={id:'fixture.race',version:'1',lane:'extract' as const,async process(){entered();await gate;return [{kind:'fixture.copy',text:'Late old result',metadata:{}}];}};
 const dispose=runtime.registry.register(processor);const id=runtime.enqueue([{name:'race',processor:processor.id,materialInputs:[{ref:record.ref}]}]).race;
 const running=runtime.tick();await started;dispose();runtime.registry.register(processor);release();await running;
 assert.equal(runtime.engine.get(id)?.state,'blocked');assert.equal(runtime.engine.get(id)?.error,'processor_instance_unavailable');assert.deepEqual(runtime.view().jobs[0].outputs,[]);
});

test('plugin installation does not authorize consumers or automatic semantic model work',async t=>{
 const {materials,runtime}=fixture(t),record=materials.publish(formal('fixture-source','grant'));let calls=0;
 runtime.registry.register({id:'fixture.paid',version:'1',lane:'semantic',async process(){calls++;return [{kind:'fixture.copy',text:'must not run',metadata:{}}];}});
 runtime.consumers.register({id:'fixture.paid',version:'1',processor:'fixture.paid',processorVersion:'1',accepts:{kind:record.kind,schemaVersion:1,key:'body'}});
 await runtime.tick();assert.equal(runtime.engine.list().items.length,0,'registration cannot scan or replay history');
 runtime.consumerAllowed=()=>true;runtime.observeProducts(record.ref,['fixture.paid']);await runtime.tick();
 assert.equal(runtime.engine.list().items[0].error,'consumer_authorization_required');assert.equal(calls,0);
});


test('a paused automatic consumer cannot gain model authorization from same-version processor replacement',async t=>{
 const {materials,runtime}=fixture(t,{extract:{concurrency:1,enabled:false}}),record=materials.publish(formal('fixture-source','replacement'));let calls=0;
 const remove=runtime.registry.register({id:'fixture.replace',version:'1',lane:'extract',deterministic:true,async process(){return [{kind:'fixture.copy',text:'Generated deterministic result',metadata:{}}];}});
 runtime.consumers.register({id:'fixture.replace',version:'1',processor:'fixture.replace',processorVersion:'1',accepts:{kind:record.kind,schemaVersion:1,key:'body'}});
 runtime.consumerAllowed=()=>true;runtime.observeProducts(record.ref,['fixture.replace']);await runtime.tick();await runtime.tick();
 assert.equal(runtime.view().jobs.length,1);assert.equal(runtime.view().jobs[0].reason,'processing_disabled');
 remove();runtime.registry.register({id:'fixture.replace',version:'1',lane:'semantic',async process(){calls++;return [{kind:'fixture.copy',text:'must not run',metadata:{}}];}});
 runtime.configure({...runtime.settings(),extract:{concurrency:1,enabled:true}});await runtime.tick();assert.equal(calls,0);assert.equal(runtime.view().jobs[0].state,'blocked');assert.equal(runtime.view().jobs[0].reason,'consumer_authorization_required');
});

test('catalog cursors pin owner, filter, registration generation and contents; historical unknown types stay readable',t=>{
 const {materials}=fixture(t);materials.publish(formal('fixture-source','one'));materials.publish(formal('fixture-source','two'));
 const unregister=materials.catalog.registry.register({id:'fixture.document',kind:'fixture.document',schemaVersion:1,label:'Generated type',card:'fixture.card'});
 const page=materials.catalog.list({limit:1},'generated-owner-a');assert.equal(page.items.length,1);assert.ok(page.nextCursor);
 assert.equal(materials.catalog.list({limit:1,cursor:page.nextCursor!},'generated-owner-a').items.length,1);
 for(const args of [{limit:1,cursor:page.nextCursor!,sourceId:'other'},{limit:2,cursor:page.nextCursor!}])assert.throws(()=>materials.catalog.list(args,'generated-owner-a'),{statusCode:409});
 assert.throws(()=>materials.catalog.list({limit:1,cursor:page.nextCursor!},'generated-owner-b'),{statusCode:409});
 assert.throws(()=>materials.catalog.list({limit:1,cursor:page.nextCursor!+'x'},'generated-owner-a'),{statusCode:400});
 unregister();assert.throws(()=>materials.catalog.list({limit:1,cursor:page.nextCursor!},'generated-owner-a'),{statusCode:409});
 const generic=materials.catalog.list({},'generated-owner-a');assert.equal(generic.types.length,0);assert.equal(generic.items.length,2);assert.match(materials.read(generic.items[0].ref).text,/Generated body/);
 const latest=materials.catalog.list({limit:1},'generated-owner-a');materials.retire(latest.items[0].id,{expectedRevision:latest.items[0].revision});assert.throws(()=>materials.catalog.list({limit:1,cursor:latest.nextCursor!},'generated-owner-a'),{statusCode:409});
});
