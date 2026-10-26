import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FILE_PART_BYTES,noteCapture,noteSchema} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import type {TranscriptionProvider} from '../src/file-processing.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
async function fixture(t:TestContext,transcriptionProvider?:TranscriptionProvider,processAudio=false){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-ui-ia-context-'));
 const config:Config={dataDir,token:'generated-ui-ia-owner-token-1234567890',tokenPath:'fixture-only',host:'127.0.0.1',port:47832,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const result=await buildApp(config,{backgroundWorker:false,transcriptionProvider,agent:{configured:false,query:async()=>{throw Error('No live model in generated fixture');},close:async()=>{}}});
 if(processAudio){const settings={...result.processing.view().settings,enabled:true,audioProcessor:'audio.http'};await result.processing.save({revision:result.processing.view().revision,settings,policy:fixtureFilePolicy(settings,result.processing.runtime.registry)});await authorizeFixtureModels(result);}
 t.after(async()=>{await result.app.close();rmSync(dataDir,{recursive:true,force:true});});return {...result,headers:{authorization:`Bearer ${config.token}`}};
}
const when='2026-10-01T10:00:00.000Z';
const note=(patch:Record<string,unknown>={})=>({id:randomUUID(),deviceId:'generated-owner-device',deviceName:'Generated device',platform:'android',capturedAt:when,text:'',...patch});

test('attachment-only record survives resumable binary transfer and ACK retry; deleted original leaves its material',async t=>{
 const {app,store,materials,materialOrganizer,headers}=await fixture(t);
 const source={id:'generated-note-attachments',name:'Generated attachments',kind:'local-files',deviceId:'generated-owner-device',platform:'android',retention:'archive'};
 const registered=await app.inject({method:'POST',url:'/api/sources',headers,payload:source});assert.ok([200,201].includes(registered.statusCode),registered.body);
 const bytes=Buffer.alloc(FILE_PART_BYTES+113,73);Buffer.from('Generated attachment original').copy(bytes);
 const manifest={sourceId:source.id,previousRevision:null,item:{externalId:'generated-binary',revision:'1',observedAt:when,title:'Generated original.bin',text:'',kind:'file',layer:'original',mimeType:'application/octet-stream'},relativePath:'generated/original.bin',sizeBytes:bytes.length,sha256:sha256(bytes)};
 const begin=async()=>{const r=await app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload:manifest});assert.equal(r.statusCode,200,r.body);return r.json();};const session=await begin();
 const part=async(index:number)=>{const r=await app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${session.uploadId}/parts/${index}`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes.subarray(index*FILE_PART_BYTES,(index+1)*FILE_PART_BYTES)});assert.equal(r.statusCode,200,r.body);};
 await part(0);assert.equal((await begin()).uploadId,session.uploadId);
 assert.equal((await app.inject({url:`/api/file-sync/v1/uploads/${session.uploadId}`,headers})).json().parts.length,1);
 const commit=()=>app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${session.uploadId}/commit`,headers,payload:{}});
 assert.equal((await commit()).statusCode,409,'partial binary upload cannot become an attachment');await part(1);
 const committed=await commit();assert.equal(committed.statusCode,200,committed.body);const attachment=committed.json();assert.deepEqual((await commit()).json(),attachment);
 const input=note({metadata:{version:1,observedAt:when,attachments:[attachment.id]}});
 const saved=await app.inject({method:'POST',url:'/api/notes',headers,payload:input});assert.equal(saved.statusCode,201,saved.body);
 assert.equal((await app.inject({method:'POST',url:'/api/notes',headers,payload:input})).json().id,input.id);
 assert.equal((await app.inject({method:'POST',url:'/api/captures',headers,payload:noteCapture(noteSchema.parse(input))})).statusCode,200);
 const read=(await app.inject({url:`/api/notes/${input.id}`,headers})).json();assert.deepEqual(read.metadata.attachments,[attachment.id]);assert.equal(read.ocrText,'');
 const content=await app.inject({url:`/api/files/${attachment.id}/content`,headers});assert.equal(content.statusCode,200,content.body);assert.deepEqual(content.rawPayload,bytes);
 await materialOrganizer.tick(100);const material=materials.list({}).items.find(item=>item.origin.externalId===input.id)!;assert.ok(material);
 assert.ok(materials.read(material.id).spans.some(span=>span.asset?.hash===sha256(bytes)));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE id=?').get(input.id)?.n,1);
 const missing=note({metadata:{version:1,observedAt:when,attachments:[randomUUID()]}});
 assert.equal((await app.inject({method:'POST',url:'/api/notes',headers,payload:missing})).statusCode,404);assert.equal(store.evidence([missing.id]).length,0);
 const deleted=await app.inject({method:'DELETE',url:`/api/files/${attachment.id}`,headers});assert.equal(deleted.statusCode,200,deleted.body);await materialOrganizer.tick(100);
 assert.equal((await app.inject({url:`/api/files/${attachment.id}/content`,headers})).statusCode,404);
 const current=materials.get(material.id);assert.ok(!current||!materials.read(current.id).spans.some(span=>span.asset?.hash===sha256(bytes)),'deleted original cannot survive through parent material');
});

test('shared original and owner comment remain separate in evidence, public search and material roles',async t=>{
 const {app,store,materials,materialOrganizer,headers}=await fixture(t);
 const input=note({text:'Generated owner annotation CedarComment',metadata:{version:1,observedAt:when,noteOrigin:{kind:'share',text:'Generated third party original OrchidOriginal',app:'Generated external app',url:'https://generated.invalid/original'}}});
 const response=await app.inject({method:'POST',url:'/api/notes',headers,payload:input});assert.equal(response.statusCode,201,response.body);
 const stored=(await app.inject({url:`/api/notes/${input.id}`,headers})).json();assert.equal(stored.ocrText,input.text);assert.equal(stored.metadata.noteOrigin.text,(input.metadata as any).noteOrigin.text);
 for(const query of ['CedarComment','OrchidOriginal']){assert.ok(store.search({query}).some(item=>item.id===input.id),query);const page=await app.inject({url:'/api/context/search?query='+query,headers});assert.equal(page.statusCode,200,page.body);assert.ok(page.json().items.length,query+' in public retrieval');}
 await materialOrganizer.tick(100);const material=materials.list({}).items.find(item=>item.origin.externalId===input.id)!;assert.ok(material);const evidence=materials.evidence(materials.evidenceIds(material.id));
 assert.ok(evidence.some(item=>item.ocrText.includes('OrchidOriginal')&&item.provenance?.document?.contentRole==='reference'));
 assert.ok(evidence.some(item=>item.ocrText.includes('CedarComment')&&item.provenance?.document?.contentRole==='authored'));
});

test('context trees project same model IDs across dimensions with scoped pagination and disposable plugin cursors',async t=>{
 const {app,store,memories,featureServices,headers}=await fixture(t),ids:string[]=[];
 for(let index=0;index<4;index++){
  const input=note({text:'Generated durable coding choice '+index,...(index===3?{deviceId:'generated-other-device'}:{})});assert.equal((await app.inject({method:'POST',url:'/api/notes',headers,payload:input})).statusCode,201);
  const result=fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{domain:'coding',kind:'procedural',title:'Generated coding decision '+index,statement:`Generated explicit coding method ${index} [${input.id}]`,uncertainty:'Generated evidence only',evidenceIds:[input.id],coding:{kind:'decision',scope:'session',applicability:'Generated method only',validation:'observed'}}]}),citations:[{id:input.id,capturedAt:when,appName:'Generated notes',excerpt:input.text}],trace:[],runId:randomUUID()});
  const saved=memories.extract(result,'generated-model').items[0];memories.publish(saved.id);ids.push(saved.id);
 }
 const before=store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n,trees=featureServices.contextTrees;
 const contribution={id:'generated.plugin',version:'1',label:'Generated plugin tree',nodes:[{id:'exact',label:'Generated exact membership',select:{memoryIds:ids}}]};const dispose=trees.register(contribution);
 const catalog=await app.inject({url:'/api/context-trees',headers});assert.equal(catalog.statusCode,200);assert.ok(catalog.json().items.some((tree:any)=>tree.id==='generated.plugin'));
 const read=async(path:string,query:Record<string,string>={})=>{const r=await app.inject({url:'/api/context-trees/'+path+'?'+new URLSearchParams(query),headers});assert.equal(r.statusCode,200,r.body);return r.json();};
 for(const path of ['topics/nodes/coding','topics/nodes/coding.decision','knowledge/nodes/procedural','use/nodes/coding','generated.plugin/nodes/exact']){
  const found=new Set<string>();let cursor:string|null=null;do{const page=await read(path,{limit:'1',deviceId:'generated-owner-device',...(cursor?{cursor}:{})});for(const item of page.items){assert.ok(!found.has(item.id));found.add(item.id);}cursor=page.nextCursor;}while(cursor);assert.deepEqual(found,new Set(ids.slice(0,3)),path);
 }
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n,before);
 assert.deepEqual((await read('topics/nodes/coding',{after:'2026-10-02T00:00:00Z'})).items,[]);
 const first=await read('generated.plugin/nodes/exact',{limit:'1'});assert.ok(first.nextCursor);
 assert.equal((await app.inject({url:'/api/context-trees/generated.plugin/nodes/exact?'+new URLSearchParams({cursor:first.nextCursor,deviceId:'generated-other-device'}),headers})).statusCode,409);
 dispose();assert.equal((await app.inject({url:'/api/context-trees/generated.plugin/nodes/exact',headers})).statusCode,404);
 const restore=trees.register({...contribution,version:'2',nodes:[{...contribution.nodes[0],select:{memoryIds:ids.slice(1)}}]});t.after(restore);
 assert.equal((await app.inject({url:'/api/context-trees/generated.plugin/nodes/exact?cursor='+encodeURIComponent(first.nextCursor),headers})).statusCode,409);
});

test('late attachment processing cannot restore deleted source content through an existing note material',async t=>{
 let started!:()=>void,release!:(value:any)=>void;const begun=new Promise<void>(done=>{started=done;});
 const {app,headers,store,sources,files,processing,materialOrganizer,materials}=await fixture(t,{transcribe:async()=>{started();return new Promise(done=>{release=done;});}},true);
 sources.register({id:'generated-late-audio',name:'Generated audio',kind:'local-files',deviceId:'generated-owner-device',platform:'android',retention:'archive'});
 const bytes=Buffer.from('Generated audio original retained for delayed processor');
 const session=files.begin({sourceId:'generated-late-audio',previousRevision:null,item:{externalId:'generated-audio',revision:'1',observedAt:when,title:'Generated audio.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},relativePath:'generated/audio.wav',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 files.part(session.uploadId,0,bytes,()=>{});const ack=await files.commit(session.uploadId,()=>{});
 const input=note({metadata:{version:1,observedAt:when,attachments:[ack.id]}});assert.equal((await app.inject({method:'POST',url:'/api/notes',headers,payload:input})).statusCode,201);
 await materialOrganizer.tick(100);const parent=materials.list({}).items.find(item=>item.origin.externalId===input.id)!;assert.ok(parent);assert.ok(materials.read(parent.id).spans.some(span=>span.asset?.hash===sha256(bytes)));
 await processing.runtime.ready;const settings={...processing.view().settings,enabled:true,audioProcessor:'audio.http'};
 await processing.save({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
 const running=processing.tick();await begun;
 const deleted=await app.inject({method:'DELETE',url:`/api/files/${ack.id}`,headers});assert.equal(deleted.statusCode,200,deleted.body);
 release({durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated late transcript must stay absent'}]});await running;await materialOrganizer.tick(100);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM file_chunks WHERE capture_id=?').get(ack.id)?.n,0);
 assert.deepEqual(store.search({query:'late transcript'}),[]);
 const current=materials.get(parent.id);assert.ok(!current||!materials.read(current.id).spans.some(span=>span.asset?.hash===sha256(bytes)));
 assert.equal((await app.inject({url:`/api/files/${ack.id}/content`,headers})).statusCode,404);
});

test('partial attachment extraction stays visibly partial on the parent note material',async t=>{
 const {app,headers,store,sources,files,processing,materialOrganizer,materials}=await fixture(t,undefined,true);
 sources.register({id:'generated-partial-audio',name:'Generated partial audio',kind:'local-files',deviceId:'generated-owner-device',platform:'android',retention:'archive'});
 const bytes=Buffer.from('Generated partial audio fixture');const session=files.begin({sourceId:'generated-partial-audio',previousRevision:null,item:{externalId:'partial-audio',revision:'1',observedAt:when,title:'Generated partial.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},relativePath:'partial.wav',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 files.part(session.uploadId,0,bytes,()=>{});const ack=await files.commit(session.uploadId,()=>{});
 const input=note({text:'Generated independent owner comment',metadata:{version:1,observedAt:when,attachments:[ack.id]}});assert.equal((await app.inject({method:'POST',url:'/api/notes',headers,payload:input})).statusCode,201);
 await processing.runtime.ready;
 processing.runtime.registry.get('audio.http').process=async()=>({durationMs:1000,coverage:'partial',segments:[{startMs:0,endMs:1000,text:'Generated available partial transcript'}]});
 const settings={...processing.view().settings,enabled:true,audioProcessor:'audio.http'};await processing.save({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
 await processing.tick();assert.equal(files.detail(ack.id).job.state,'succeeded',JSON.stringify(files.detail(ack.id)));await materialOrganizer.tick(100);
 const parent=materials.list({}).items.find(item=>item.origin.externalId===input.id)!;assert.ok(parent);assert.equal(parent.coverage.state,'partial','available excerpt must never imply complete attachment coverage');
 assert.ok(store.db.prepare('SELECT json FROM file_artifacts WHERE capture_id=? AND current=1').all(ack.id).map(row=>JSON.parse(String(row.json))).some(artifact=>artifact.complete===false&&artifact.coverage==='partial'));
 assert.match(materials.read(parent.id).text,/Generated independent owner comment/);assert.match(materials.read(parent.id).text,/Generated available partial transcript/);
});
