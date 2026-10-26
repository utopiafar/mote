import test from 'node:test';
import sharp from 'sharp';
import {createServer} from 'node:http';
import {sha256,Store} from '../src/store.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {readAgentCredential} from './login-fixture.js';
async function fixture(t:import('node:test').TestContext,factory:ModelAgentFactory,overrides:Partial<Config>={},limits?:{maxStorageBytes:number}){
 const directory=await mkdtemp(join(tmpdir(),'mote-authorization-http-'));
 const config:Config={dataDir:directory,token:'generated-owner-only',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://fixture.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',...overrides};
 let fixtureStore=limits?new Store(directory,limits):undefined;
 let node=await buildApp(config,{backgroundWorker:false,createModelAgent:factory,store:fixtureStore});const headers={authorization:'Bearer '+config.token};
 t.after(async()=>{await node.app.close();fixtureStore?.close();await rm(directory,{recursive:true,force:true});});
 return {get node(){return node;},headers,async restart(){await node.app.close();fixtureStore?.close();fixtureStore=limits?new Store(directory,limits):undefined;node=await buildApp(config,{backgroundWorker:false,createModelAgent:factory,store:fixtureStore});},
 async intake(text:string){const id=randomUUID();const response=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:text}});assert.equal(response.statusCode,201,response.body);return id;},
 async command(action:'authorize'|'pause'|'stop'){const view=(await node.app.inject({url:'/api/model-authorization',headers})).json();const response=await node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers,payload:{revision:view.authorization.revision,operationId:randomUUID(),action,...(action==='authorize'?{connections:view.connections,scope:{sourceIds:['device:generated-device'],dataKinds:['text']}}:{})}});assert.equal(response.statusCode,200,response.body);return response.json();}};
}
test('HTTP owner approval governs actual query reader/send and survives restart without backfilling old triggers',async t=>{
 const observed:string[][]=[];
 const f=await fixture(t,async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{const records=await reader.evidence({ids:input.evidenceIds??[]});observed.push(records.map(record=>record.ocrText));return {answer:'Generated answer',citations:[],trace:[],runId:'generated'};}}));
 const old=await f.intake('Generated historical context');
 const query=(ids:string[])=>f.node.featureServices.queryAgent({question:'Generated task',evidenceIds:ids,traceContext:{operationId:randomUUID()}},'query','working');
 await assert.rejects(query([old]));assert.equal(observed.length,0);
 await f.command('authorize');await assert.rejects(query([old]));
 const fresh=await f.intake('Generated accepted trigger');await query([old,fresh]);assert.deepEqual(new Set(observed[0]),new Set(['Generated historical context','Generated accepted trigger']));
 await f.command('pause');const gap=await f.intake('Generated pause gap');await assert.rejects(query([gap]));
 await f.restart();assert.equal(f.node.modelAuthorization.view().state,'paused');await f.command('authorize');await assert.rejects(query([gap]));
 const next=await f.intake('Generated after restart');await query([old,next]);assert.equal(observed.length,2);
});
test('HTTP stop aborts an executing model and rejects its late response, without discarding original intake',async t=>{
 let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);let signal:AbortSignal|undefined;
 const f=await fixture(t,async()=>({configured:true,close:async()=>{},query:async input=>{signal=input.signal;enter();await held;return {answer:'Late generated answer',citations:[],trace:[],runId:'generated'};}}));
 await f.command('authorize');const id=await f.intake('Generated original retained');
 const running=f.node.featureServices.queryAgent({question:'Generated task',evidenceIds:[id],traceContext:{operationId:randomUUID()}},'query','working');
 await started;await f.command('stop');assert.equal(signal?.aborted,true);release();await assert.rejects(running);
 assert.equal(f.node.store.evidence([id])[0].ocrText,'Generated original retained');await f.restart();assert.equal(f.node.modelAuthorization.view().state,'stopped');
});
test('authorization HTTP routes reject non-owner credentials, stale writes and forged model fingerprints',async t=>{
 const f=await fixture(t,async()=>({configured:true,close:async()=>{},query:async()=>{throw Error('No fixture model call expected');}}));
 const restricted=await readAgentCredential(f.node.connections);
 for(const method of ['GET','POST'] as const){const url='/api/model-authorization'+(method==='POST'?'/commands':'');assert.equal((await f.node.app.inject({method,url,payload:method==='POST'?{}:undefined})).statusCode,401);assert.equal((await f.node.app.inject({method,url,headers:{authorization:'Bearer '+restricted.token},payload:method==='POST'?{}:undefined})).statusCode,403);}
 const view=(await f.node.app.inject({url:'/api/model-authorization',headers:f.headers})).json();
 const forged=await f.node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:f.headers,payload:{revision:0,operationId:randomUUID(),action:'authorize',connections:[{...view.connections[0],fingerprint:'0'.repeat(64)}],scope:{sourceIds:null,dataKinds:['text']}}});assert.equal(forged.statusCode,409);
 await f.command('authorize');const stale=await f.node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:f.headers,payload:{revision:0,operationId:randomUUID(),action:'stop'}});assert.equal(stale.statusCode,409);assert.equal(f.node.modelAuthorization.view().state,'enabled');
});


test('assembled media host admits approved new audio and explicit owner retry of historical audio across restart',async t=>{
 const bodies:Buffer[]=[];
 const service=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));bodies.push(Buffer.concat(chunks));res.setHeader('Content-Type','application/json');res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated assembled transcript'}]}));});
 await new Promise<void>(resolve=>service.listen(0,'127.0.0.1',resolve));const address=service.address();assert.ok(address&&typeof address!=='string');
 t.after(async()=>{service.closeAllConnections();await new Promise<void>(resolve=>service.close(()=>resolve()));});
 const f=await fixture(t,async()=>({configured:true,close:async()=>{},query:async()=>{throw Error('No language model call expected');}}));
 const settings={...f.node.processing.currentSettings(),enabled:true,audioProcessor:'audio.http',endpoint:'http://127.0.0.1:'+address.port+'/transcribe',summarize:false};
 await f.node.processing.save({revision:f.node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.node.processing.runtime.registry)});
 f.node.sources.register({id:'generated-audio',name:'Generated audio',kind:'local-files',deviceId:'generated-device',platform:'import',retention:'archive'});
 const upload=async()=>{const bytes=Buffer.from('Generated audio '+randomUUID()),begun=f.node.files.begin({sourceId:'generated-audio',item:{externalId:randomUUID(),revision:'1',observedAt:new Date().toISOString(),title:'Generated audio',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});f.node.files.part(begun.uploadId,0,bytes,()=>{});return {id:(await f.node.files.commit(begun.uploadId,()=>{})).id,bytes};};
 const old=await upload();await f.node.processing.tick();assert.equal(bodies.length,0);assert.equal(f.node.files.detail(old.id).hasOriginal,true);
 const view=(await f.node.app.inject({url:'/api/model-authorization',headers:f.headers})).json();
 const approved=await f.node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:f.headers,payload:{revision:view.authorization.revision,operationId:randomUUID(),action:'authorize',connections:view.connections,scope:{sourceIds:['generated-audio'],dataKinds:['audio','text']}}});assert.equal(approved.statusCode,200,approved.body);
 const fresh=await upload();await f.node.processing.tick();assert.equal(bodies.length,1);assert.deepEqual(bodies[0],fresh.bytes);assert.equal(f.node.files.chunks(fresh.id)[0].ocrText,'Generated assembled transcript');
 const retried=await f.node.app.inject({method:'POST',url:'/api/files/'+old.id+'/retry',headers:f.headers,payload:{stage:'transcribe'}});assert.equal(retried.statusCode,200,retried.body);
 await f.restart();await f.node.processing.tick();assert.equal(bodies.length,2);assert.deepEqual(bodies[1],old.bytes);assert.equal(f.node.files.chunks(old.id)[0].ocrText,'Generated assembled transcript');
});


test('assembled embedding transport requires approval and stop fences its late vector publication',async t=>{
 const inputs:string[]=[];let hold=false,enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 const service=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));inputs.push(JSON.parse(Buffer.concat(chunks).toString()).input);if(hold){enter();await held;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{embedding:[1,0]}]}));});
 await new Promise<void>(resolve=>service.listen(0,'127.0.0.1',resolve));const address=service.address();assert.ok(address&&typeof address!=='string');
 t.after(async()=>{release();service.closeAllConnections();await new Promise<void>(resolve=>service.close(()=>resolve()));});
 const f=await fixture(t,async()=>({configured:true,close:async()=>{},query:async()=>{throw Error('No language model call expected');}}),{embeddingModel:'generated-vector',embeddingBaseUrl:'http://127.0.0.1:'+address.port,embeddingApiKey:'generated-vector-key'});
 const old=await f.intake('Generated historical embedding');await f.node.indexer.tick();assert.equal(inputs.length,0);
 await f.command('authorize');const fresh=await f.intake('Generated approved embedding');await f.node.indexer.tick();assert.equal(inputs.length,1);assert.match(inputs[0],/Generated approved embedding/);
 assert.equal(f.node.store.db.prepare('SELECT index_status FROM captures WHERE id=?').get(fresh)!.index_status,'indexed');
 hold=true;const late=await f.intake('Generated late embedding');const running=f.node.indexer.tick();await started;await f.command('stop');release();await running;
 assert.equal(inputs.length,2);assert.notEqual(f.node.store.db.prepare('SELECT index_status FROM captures WHERE id=?').get(late)!.index_status,'indexed');assert.ok(f.node.store.evidence([old,late]).length===2);
});


test('historical image confirmation persists only frozen owner intents and executes after Central restart',async t=>{
 const bodies:Buffer[]=[];const service=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));bodies.push(Buffer.concat(chunks));res.setHeader('Content-Type','application/json');res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated historical OCR'}]}));});
 await new Promise<void>(resolve=>service.listen(0,'127.0.0.1',resolve));const address=service.address();assert.ok(address&&typeof address!=='string');
 t.after(async()=>{service.closeAllConnections();await new Promise<void>(resolve=>service.close(()=>resolve()));});
 const f=await fixture(t,async()=>({configured:true,close:async()=>{},query:async()=>{throw Error('No language model expected');}}));
 const settings={...f.node.processing.currentSettings(),enabled:true,imageProcessor:'image.http',imageEndpoint:'http://127.0.0.1:'+address.port+'/ocr',summarize:false};
 await f.node.processing.save({revision:f.node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.node.processing.runtime.registry)});
 await f.node.perception.save({revision:f.node.perception.view().revision,settings:{...f.node.perception.settings(),enabled:true,understandingEnabled:false}});
 f.node.sources.register({id:'generated-pictures',name:'Generated pictures',kind:'local-files',deviceId:'generated-device',platform:'import',retention:'archive'});
 const upload=async(color:string)=>{const bytes=await sharp({create:{width:4,height:4,channels:3,background:color}}).png().toBuffer(),begun=f.node.files.begin({sourceId:'generated-pictures',item:{externalId:randomUUID(),revision:'1',observedAt:new Date().toISOString(),title:'Generated picture',kind:'file',layer:'original',text:'',mimeType:'image/png',deleted:false},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});f.node.files.part(begun.uploadId,0,bytes,()=>{});return {id:(await f.node.files.commit(begun.uploadId,()=>{})).id,bytes};};
 const old=await upload('#ffee00');await f.node.perception.tick();assert.equal(bodies.length,0);
 const preview=await f.node.app.inject({method:'POST',url:'/api/perception/ocr/historical-preview',headers:f.headers,payload:{sourceId:'generated-pictures'}});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().count,1);
 const later=await upload('#00eeff');
 const confirmed=await f.node.app.inject({method:'POST',url:'/api/perception/ocr/historical-process',headers:f.headers,payload:{token:preview.json().token}});assert.equal(confirmed.statusCode,200,confirmed.body);
 const duplicate=await f.node.app.inject({method:'POST',url:'/api/perception/ocr/historical-process',headers:f.headers,payload:{token:preview.json().token}});assert.equal(duplicate.statusCode,409);
 await f.restart();await f.node.perception.tick();assert.equal(bodies.length,1);assert.deepEqual(bodies[0],old.bytes);
 assert.ok(f.node.perception.detail(old.id).products.some(product=>product.kind==='ocr'));assert.equal(f.node.perception.detail(later.id).products.length,0);
 assert.equal(f.node.modelAuthorization.view().state,'unapproved','manual batch never enables future background processing');
});

test('assembled image understanding publishes with image and text approval without conversation access',async t=>{
 let calls=0,pixels=0;
 const f=await fixture(t,async(_settings,reader,host)=>({configured:true,close:async()=>{},query:async input=>{
  calls++;host?.authorizeModelRequest?.();input.assertContextAuthority?.();
  const image=await reader.readImage!({id:input.directImages![0].id});assert.ok(image.data);pixels++;
  return {answer:JSON.stringify({text:'Generated blue rectangle, attribution unknown.',regions:[]}),citations:[],trace:[],runId:randomUUID()};
 }}));
 await f.node.processing.saveImageDefault({endpoint:'http://127.0.0.1:1/generated-ocr'});
 f.node.processing.runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[]});
 await f.node.perception.save({revision:f.node.perception.view().revision,settings:{...f.node.perception.settings(),enabled:true,understandingEnabled:true}});
 f.node.sources.register({id:'generated-vlm',name:'Generated VLM',kind:'local-files',deviceId:'generated-device',platform:'import',retention:'archive'});
 const view=(await f.node.app.inject({url:'/api/model-authorization',headers:f.headers})).json();
 const approval=await f.node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:f.headers,payload:{revision:view.authorization.revision,operationId:randomUUID(),action:'authorize',connections:view.connections,scope:{sourceIds:['generated-vlm'],dataKinds:['image','text']}}});assert.equal(approval.statusCode,200,approval.body);
 const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#1122aa'}}).png().toBuffer(),begun=f.node.files.begin({sourceId:'generated-vlm',item:{externalId:randomUUID(),revision:'1',observedAt:new Date().toISOString(),kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});f.node.files.part(begun.uploadId,0,bytes,()=>{});const id=(await f.node.files.commit(begun.uploadId,()=>{})).id;
 await f.node.perception.tick();
 assert.equal(calls,1,JSON.stringify(f.node.perception.detail(id)));assert.equal(pixels,1);
 assert.ok(f.node.perception.detail(id).products.some(product=>product.kind==='understanding'));
});


test('HTTP historical quota failures leave no manual admission or bytes across retry and restart',async t=>{
 const limits={maxStorageBytes:20_000_000};const f=await fixture(t,async()=>({configured:true,close:async()=>{},query:async()=>{throw Error('No model expected');}}),{},limits);
 f.node.sources.register({id:'generated-quota',name:'Generated quota',kind:'local-files',deviceId:'generated-device',platform:'import',retention:'archive'});
 const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#224466'}}).png().toBuffer(),begun=f.node.files.begin({sourceId:'generated-quota',item:{externalId:randomUUID(),revision:'1',observedAt:new Date().toISOString(),kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});f.node.files.part(begun.uploadId,0,bytes,()=>{});await f.node.files.commit(begun.uploadId,()=>{});f.node.perception.prepare();
 const preview=await f.node.app.inject({method:'POST',url:'/api/perception/ocr/historical-preview',headers:f.headers,payload:{sourceId:'generated-quota'}});assert.equal(preview.statusCode,200,preview.body);
 const before=f.node.store.logicalBytes(),count=f.node.store.db.prepare('SELECT count(*) n FROM background_model_work').get()!.n;
 const connections=f.node.featureServices.availableModelConnections(),manualBytes=Buffer.byteLength(JSON.stringify({id:'owner-media-batch:'+randomUUID(),kind:'manual',epoch:0,roots:['capture:'+('0'.repeat(36))],connections,scope:{sourceIds:null,dataKinds:['text','image','audio','conversation']}}))+300;
 limits.maxStorageBytes=before+manualBytes;
 for(let i=0;i<2;i++){const response=await f.node.app.inject({method:'POST',url:'/api/perception/ocr/historical-process',headers:f.headers,payload:{token:preview.json().token}});assert.equal(response.statusCode,507,response.body);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM background_model_work').get()!.n,count);assert.equal(f.node.store.logicalBytes(),before);}
 limits.maxStorageBytes=20_000_000;await f.restart();assert.equal(f.node.store.logicalBytes(),before);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM background_model_work').get()!.n,count);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM image_backfill_items').get()!.n,0);
 const next=await f.node.app.inject({method:'POST',url:'/api/perception/ocr/historical-preview',headers:f.headers,payload:{sourceId:'generated-quota'}});const approved=await f.node.app.inject({method:'POST',url:'/api/perception/ocr/historical-process',headers:f.headers,payload:{token:next.json().token}});assert.equal(approved.statusCode,200,approved.body);
});


test('lazy original admission resolves once and retains pause, restart and stop fences',async t=>{
 const f=await fixture(t,async()=>({configured:true,close:async()=>{},query:async()=>({answer:'Generated',citations:[],trace:[],runId:'generated'})}));
 await f.command('authorize');const id=await f.intake('Generated prospective original');let resolutions=0,runs=0;
 const work='generated-lazy-admission';
 const forbidden=():readonly string[]=>{assert.fail('existing admission must not resolve original metadata again');};
 await f.node.modelAuthorizationHost.automatic(work,'memory',()=>{resolutions++;return f.node.modelAuthorizationHost.evidenceTriggers([id]);},async()=>{
  runs++;
  await f.node.modelAuthorizationHost.automatic('generated-dependent','memory',forbidden,async()=>{runs++;});
 });
 assert.equal(resolutions,1);await f.command('pause');await f.restart();
 await f.node.modelAuthorizationHost.automatic(work,'memory',forbidden,async()=>{runs++;});
 assert.equal(runs,3);await f.command('stop');
 await assert.rejects(f.node.modelAuthorizationHost.automatic(work,'memory',forbidden,async()=>{runs++;}));
 assert.equal(runs,3);assert.equal(resolutions,1);
});
