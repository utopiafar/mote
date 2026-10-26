import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {FileProcessing} from '../src/file-processing.js';
import {HttpTranscriptionProvider} from '../src/file-processors.js';
import {ImageProcessing,type ImageUnderstanding} from '../src/image-processing.js';
import {imageUnderstanding} from '../src/image-understanding.js';
import type {ModelSettings} from '@mote/shared/models';
import {ExecutionEngine} from '../src/execution-engine.js';
import {BackgroundModelAuthorization} from '../src/background-model-authorization.js';
import type {ModelProcessingAuthority,ModelProcessingRequest} from '../src/model-processing-authority.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
const audio=Buffer.from('Generated audio fixture bytes, not a microphone recording.');
const transcript={durationMs:3000,segments:[{startMs:0,endMs:1000,text:'Generated orchard transcript.'}]};
async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-media-authority-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources);
 new ArchivedFileStore(store);
 const requests:{path:string;bytes:Buffer}[]=[],seen:ModelProcessingRequest[]=[];
 let hold:Promise<void>|undefined,summaryCalls=0,ownerIntentCalls=0,release:()=>void=()=>{},arrived:()=>void=()=>{};
 const service=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));requests.push({path:req.url!,bytes:Buffer.concat(chunks)});arrived();await hold;res.setHeader('Content-Type','application/json');res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify(req.url==='/ocr'?{durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated yellow orchard.'}]}:req.url==='/diarize'?{durationMs:3000,engine:'generated',expectedSpeakers:null,observedSpeakers:1,overlapDetection:'unknown',segments:[{startMs:0,endMs:3000,speaker:'SPEAKER_0'}],samples:[]}:transcript));});
 await new Promise<void>(resolve=>service.listen(0,'127.0.0.1',resolve));const address=service.address();assert.ok(address&&typeof address!=='string');const url='http://127.0.0.1:'+address.port;
 sources.register({id:'phone',name:'Generated phone',kind:'local-files',deviceId:'generated-phone',platform:'android',retention:'archive'});
 let processing:FileProcessing,engine:ExecutionEngine,control:BackgroundModelAuthorization,images:ImageProcessing|undefined;
 const authority:ModelProcessingAuthority=async(request,signal,task)=>{
  seen.push({...request});const id=request.ownerIntentId??control.currentId??'automatic-media:'+request.captureId;
  if(request.ownerIntentId)control.assertOwnerIntent(id,request.captureId);
  if(!request.ownerIntentId&&!control.currentId)control.automatic(id,[request.captureId],'file');
  return control.run(id,async authorizedSignal=>{const check=()=>{authorizedSignal.throwIfAborted();control.assertCurrent(request.connection);control.assertDisclosure([{sourceId:files.version(request.captureId).source_id,dataKind:request.dataKind}]);};check();const result=await task(authorizedSignal,check);check();return result;},signal);
 };
 authority.ownerIntent=captureId=>{ownerIntentCalls++;const id=control.currentId;if(id&&control.currentKind==='manual'){control.assertOwnerIntent(id,captureId);return id;}return undefined;};
 let configuration:ReturnType<FileProcessing['configurationSnapshot']>|undefined;
 const create=async()=>{control=new BackgroundModelAuthorization(store,()=>processing?.modelConnections()??[]);engine=new ExecutionEngine(store);engine.bindModelAuthority(control);processing=new FileProcessing(files,undefined,undefined,{modelAuthority:authority,executor:engine,configuration,analyze:async(records,prompt)=>{summaryCalls++;return {answer:prompt.includes('groups')?JSON.stringify({groups:records.map((_r,i)=>[i])}):'Generated summary',citations:records.map(r=>({id:r.id}))};}});await processing.runtime.ready;if(!configuration){const settings={...processing.view().settings,enabled:true,audioProcessor:'audio.http',imageProcessor:'image.http',endpoint:url+'/transcribe',localEndpoint:url+'/transcribe',imageEndpoint:url+'/ocr',summarize:false};processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});}store.captureInputReceived=input=>control.receive(input.id,{sourceId:input.provenance?.sourceId??input.deviceId,dataKind:input.provenance?.mimeType?.startsWith('image/')?'image':input.provenance?.mimeType?.startsWith('audio/')?'audio':'text'});};
 await create();
 t.after(async()=>{release();service.closeAllConnections();await new Promise<void>(resolve=>service.close(()=>resolve()));await images?.close();await processing.close();await engine.close();control.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const upload=async(bytes=audio,mimeType='audio/wav')=>{const begun=files.begin({sourceId:'phone',item:{externalId:randomUUID(),revision:'1',observedAt:new Date().toISOString(),title:'Generated original',kind:'file',layer:'original',text:'',mimeType,deleted:false},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});files.part(begun.uploadId,0,bytes,()=>{});return (await files.commit(begun.uploadId,()=>{})).id;};
 const command=(action:'authorize'|'pause'|'stop',dataKinds=['text','image','audio'])=>control.command({action,revision:control.view().revision,operationId:randomUUID(),...(action==='authorize'?{connections:processing.modelConnections(),scope:{sourceIds:['phone'],dataKinds}}:{})});
 return {store,files,sources,requests,seen,url,get processing(){return processing;},get engine(){return engine;},get control(){return control;},upload,command,get summaryCalls(){return summaryCalls;},get ownerIntentCalls(){return ownerIntentCalls;},
  async manual(id:string|string[],run:()=>unknown){const work='generated-manual:'+randomUUID();control.manual(work,'manual',typeof id==='string'?[id]:id);await control.run(work,async()=>{run();});return work;},
  hold(){let notify!:()=>void;const started=new Promise<void>(resolve=>notify=resolve);arrived=notify;hold=new Promise<void>(resolve=>release=resolve);return {started,release:()=>release()};},
  async restart(){configuration=processing.configurationSnapshot();await images?.close();images=undefined;await processing.close();await engine.close();control.close();await create();},
  async imageProcessor(understanding?:ImageUnderstanding){images=new ImageProcessing(store,processing,engine,{modelAuthority:authority,understanding,probeOcr:async()=>true});images.configure({...images.settings(),enabled:true,understandingEnabled:Boolean(understanding)});return images;},
 };
}

test('unapproved intake retains its original but cannot send an ASR body after later approval or restart',async t=>{
 const f=await fixture(t),id=await f.upload();assert.equal(f.files.detail(id).hasOriginal,true);await f.processing.tick();assert.equal(f.requests.length,0);
 f.command('authorize');await f.processing.tick();assert.equal(f.requests.length,0,'approval cannot fill the old gap');await f.restart();await f.processing.tick();assert.equal(f.requests.length,0);
 const fresh=await f.upload();await f.processing.tick();assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].bytes,audio);assert.equal(f.files.detail(fresh).job?.state,'succeeded');assert.equal(f.files.chunks(fresh)[0].ocrText,transcript.segments[0].text);
});

test('explicit same-target retry gets new durable steps without resetting previous automatic failures',async t=>{
 const f=await fixture(t),id=await f.upload();await f.processing.tick();const previous=f.engine.list({operationId:'file:'+id}).items.map(row=>({id:row.id,state:row.state}));
 const work=await f.manual(id,()=>f.processing.retry(id));assert.ok(f.engine.list({operationId:'file:'+id}).items.find(row=>row.input.ownerIntentId===work));await f.restart();await f.processing.tick();
 assert.equal(f.requests.length,1);assert.equal(f.files.detail(id).job?.state,'succeeded');for(const old of previous)assert.equal(f.engine.get(old.id)?.state,old.state);assert.ok(f.seen.some(row=>row.ownerIntentId===work));
});

test('stop fences a late ASR result and unknown confirmation cannot cause a second send',async t=>{
 const f=await fixture(t);f.command('authorize');const id=await f.upload(),barrier=f.hold(),tick=f.processing.tick();await barrier.started;f.command('stop');barrier.release();await tick;
 assert.equal(f.requests.length,1);assert.equal(f.files.chunks(id).length,0);assert.equal(f.files.detail(id).hasOriginal,true);
 assert.equal(f.processing.cancellation(id).wait,'unknown');{await assert.rejects(f.manual(id,()=>f.processing.retry(id,'transcribe',false,true)));assert.equal(f.requests.length,1);}
});

test('pause gaps and replaced media connections cannot inherit a previous approval',async t=>{
 const f=await fixture(t);f.command('authorize',['audio']);f.command('pause');const gap=await f.upload();f.command('authorize',['audio']);await f.processing.tick();assert.equal(f.requests.length,0);assert.equal(f.files.detail(gap).hasOriginal,true);
 const approved=f.processing.modelConnections(),config=f.processing.configurationSnapshot();config.policy.services.find(s=>s.id==='asr-api')!.apiKey='generated-replacement-secret';f.processing.update({revision:f.processing.view().revision,...config});assert.notDeepEqual(f.processing.modelConnections(),approved);
 const id=await f.upload();await f.processing.tick();assert.equal(f.requests.length,0);assert.equal(f.files.chunks(id).length,0);assert.equal(JSON.stringify(f.processing.modelConnections()).includes('generated-replacement-secret'),false);
});

test('deterministic text extraction needs no approval while summary inherits the original grant',async t=>{
 const f=await fixture(t),plain=await f.upload(Buffer.from('Generated plain text before approval.'),'text/plain');await f.processing.tick();assert.equal(f.files.chunks(plain)[0].ocrText,'Generated plain text before approval.');assert.equal(f.requests.length,0);
 const config=f.processing.configurationSnapshot();config.policy.profiles.filter(p=>p.processorId==='text.utf8').forEach(p=>p.summarize=true);config.settings.summarize=true;f.processing.update({revision:f.processing.view().revision,...config});
 const old=await f.upload(Buffer.from('Generated no automatic summary.'),'text/plain');await f.processing.tick();assert.equal(f.summaryCalls,0);assert.equal(f.files.chunks(old)[0].ocrText,'Generated no automatic summary.');
 f.command('authorize');const fresh=await f.upload(Buffer.from('Generated approved summary input.'),'text/plain');await f.processing.tick();assert.equal(f.summaryCalls,1);assert.ok(f.files.detail(fresh).artifacts.some(a=>a.kind==='summary'));assert.ok(f.seen.some(s=>s.stage==='file-summary'));
});

test('image OCR sends the exact approved bytes and retains denied originals',async t=>{
 const f=await fixture(t),images=await f.imageProcessor(),bytes=await sharp({create:{width:4,height:4,channels:3,background:'#ffee00'}}).png().toBuffer();
 f.command('authorize',['audio']);const denied=await f.upload(bytes,'image/png');await images.tick();assert.equal(f.requests.length,0);assert.equal(f.files.detail(denied).hasOriginal,true);
 f.command('authorize');const freshBytes=await sharp({create:{width:4,height:4,channels:3,background:'#aabb00'}}).png().toBuffer(),fresh=await f.upload(freshBytes,'image/png');await images.tick();assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/ocr');assert.deepEqual(f.requests[0].bytes,freshBytes);assert.ok(images.detail(fresh).products.some(p=>p.kind==='ocr'));
});

test('remote ASR cannot read an original or invoke its transport before the host check',async t=>{
 const provider=new HttpTranscriptionProvider();let calls=0,reads=0;t.mock.method(globalThis,'fetch',async(_url,input)=>{calls++;const parts:Buffer[]=[];for await(const part of input!.body as unknown as AsyncIterable<Buffer>)parts.push(part);assert.deepEqual(Buffer.concat(parts),audio);return new Response(JSON.stringify(transcript),{status:200});});
 const {fileProcessingSchema}=await import('@mote/shared'),settings=fileProcessingSchema.parse({endpoint:'https://generated-model.invalid/asr',allowRemote:true}),body={async *[Symbol.asyncIterator](){reads++;yield audio;}};
 await assert.rejects(provider.transcribe({body,sizeBytes:audio.length,mimeType:'audio/wav',settings,maxAudioMs:10000,signal:new AbortController().signal,authorizeModel:()=>{throw Error('Generated owner denial');}}));assert.equal(calls,0);assert.equal(reads,0);
 const result=await provider.transcribe({body,sizeBytes:audio.length,mimeType:'audio/wav',settings,maxAudioMs:10000,signal:new AbortController().signal,authorizeModel:()=>{}});assert.deepEqual(result,transcript);assert.equal(calls,1);assert.equal(reads,1);
});


test('local dialogue preserves one original authority across ASR, diarization and semantic grouping',async t=>{
 const f=await fixture(t),config=f.processing.configurationSnapshot();const settings={...config.settings,audioProcessor:'audio.local-dialogue',diarizationProcessor:'audio.diarize',speakerCount:null,semanticTurns:true};f.processing.update({revision:f.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.processing.runtime.registry)});f.command('authorize');const id=await f.upload();await f.processing.tick();
 assert.equal(f.files.detail(id).job?.state,'succeeded');assert.deepEqual(f.requests.map(r=>r.path),['/transcribe','/diarize']);for(const request of f.requests)assert.deepEqual(request.bytes,audio);
 assert.ok(f.files.detail(id).artifacts.some(a=>a.kind==='dialogue'&&a.semanticGrouping===true));assert.ok(f.seen.some(r=>r.stage==='diarization'));assert.ok(f.seen.some(r=>r.stage==='semantic-turns'));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM background_model_work WHERE id=?').get('automatic-media:'+id)!.n,1);
});

test('manual image retry leaves the old terminal step and preserves its new owner scope',async t=>{
 const f=await fixture(t),images=await f.imageProcessor(),bytes=await sharp({create:{width:4,height:4,channels:3,background:'#113355'}}).png().toBuffer(),id=await f.upload(bytes,'image/png');await images.tick();for(const step of f.engine.list({operationId:'image:'+id}).items)f.engine.fail(step.id,'generated_terminal_failure');const before=f.engine.list({operationId:'image:'+id}).items.map(step=>({id:step.id,state:step.state}));
 const work=await f.manual(id,()=>images.retry(id,false));await images.tick();assert.equal(f.requests.length,1);assert.ok(images.detail(id).products.some(p=>p.kind==='ocr'));assert.ok(f.seen.some(r=>r.ownerIntentId===work));for(const old of before)assert.equal(f.engine.get(old.id)?.state,old.state);
});


for(const action of ['pause','stop'] as const)test(`${action} during VLM pixel processing preserves the original and fences publication correctly`,async t=>{
 const f=await fixture(t),bytes=await sharp({create:{width:4,height:4,channels:3,background:'#448899'}}).png().toBuffer();
 const settings:ModelSettings={provider:'custom',protocol:'openai-completions',model:'generated-model',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'',headers:{},extraBody:{},maxTokens:8192,agentTimeoutMs:2000,modelRequestTimeoutMs:1000,reasoningEffort:'auto',allowUnauthenticatedLocal:true};
 let arrive!:()=>void,release!:()=>void,calls=0,closed=0,activeSignal:AbortSignal|undefined;
 const started=new Promise<void>(resolve=>arrive=resolve),held=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 const adapter=imageUnderstanding({selection:()=>({fingerprint:'generated-vlm',configured:true,receipt:{model:settings.model},settings,identity:{kind:'profile',id:'generated-vlm'}}),metered:async(_settings,_attribution,task)=>task(()=>{}),factory:async(_settings,reader,_host,identity)=>{
  assert.deepEqual(identity,{kind:'profile',id:'generated-vlm'});
  return {configured:true,close:async()=>{closed++;},query:async input=>{
   calls++;activeSignal=input.signal;input.assertContextAuthority?.();
   const pixels=await reader.readImage!({id:input.directImages![0].id});assert.equal(pixels.data,bytes.toString('base64'));arrive();await held;
   // Deliberately emulate a provider returning after cancellation.
   return {answer:JSON.stringify({text:'Generated blue image observation.',regions:[]}),citations:[],trace:[],runId:randomUUID()};
  }};
 }});
 const images=await f.imageProcessor(adapter);f.command('authorize');const id=await f.upload(bytes,'image/png'),tick=images.tick();await started;
 assert.ok(f.seen.some(request=>request.stage==='image-understanding'&&request.captureId===id));f.command(action);assert.equal(activeSignal?.aborted,action==='stop');release();await tick;
 assert.equal(calls,1);assert.equal(closed,1);assert.equal(f.files.detail(id).hasOriginal,true);
 assert.equal(images.detail(id).products.some(product=>product.kind==='understanding'),action==='pause');
 await images.tick();assert.equal(calls,1,'refresh must neither resend a completed VLM job nor resurrect stopped work');
 const gapBytes=await sharp({create:{width:4,height:4,channels:3,background:'#994488'}}).png().toBuffer(),gap=await f.upload(gapBytes,'image/png');await images.tick();assert.equal(calls,1);assert.equal(f.files.detail(gap).hasOriginal,true);
});


test('historical confirmation freezes membership and durable intents survive restart without fresh authority',async t=>{
 const f=await fixture(t);let images=await f.imageProcessor();const ids:string[]=[];
 for(const color of ['#101011','#202022','#303033'])ids.push(await f.upload(await sharp({create:{width:4,height:4,channels:3,background:color}}).png().toBuffer(),'image/png'));
 images.prepare();f.store.db.prepare("UPDATE perception_jobs SET state='succeeded' WHERE capture_id=?").run(ids[2]);
 const preview=images.previewHistoricalOcr({sourceId:'phone'}),targets=images.historicalOcrTargets({token:preview.token});assert.deepEqual(targets,ids.slice(0,2));
 // This old image becomes eligible after confirmation selection; it must not join the batch.
 f.store.db.prepare('UPDATE image_inputs SET auto_eligible=0 WHERE capture_id=?').run(ids[2]);assert.deepEqual(images.historicalOcrTargets({token:preview.token}),targets);
 const work=await f.manual([...targets],()=>images.processHistoricalOcr({token:preview.token}));
 for(const id of targets)assert.equal(f.processing.modelIntent(id,'image'),work);
 assert.throws(()=>images.processHistoricalOcr({token:preview.token}),{statusCode:409});const calls=f.ownerIntentCalls;
 await f.restart();images=await f.imageProcessor();
 for(const until=Date.now()+5000;Date.now()<until&&targets.some(id=>!images.detail(id).products.some(product=>product.kind==='ocr'));){await images.tick();await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(f.ownerIntentCalls,calls,'background restart must not request owner authority');assert.equal(f.requests.length,2,JSON.stringify({batch:f.store.db.prepare('SELECT * FROM image_backfills').all(),items:f.store.db.prepare('SELECT * FROM image_backfill_items').all(),jobs:f.store.db.prepare('SELECT * FROM perception_jobs').all(),seen:f.seen}));
 for(const id of targets)assert.ok(images.detail(id).products.some(p=>p.kind==='ocr'));
 assert.equal(f.processing.modelIntent(ids[2],'image'),undefined);assert.equal(images.detail(ids[2]).products.length,0);
 await images.tick();assert.equal(f.requests.length,2);assert.equal(f.ownerIntentCalls,calls);
});

test('historical confirmation rolls back missing item authority and keeps the preview retryable',async t=>{
 const f=await fixture(t),images=await f.imageProcessor(),ids:string[]=[];
 for(const color of ['#415161','#718191'])ids.push(await f.upload(await sharp({create:{width:4,height:4,channels:3,background:color}}).png().toBuffer(),'image/png'));
 images.prepare();const preview=images.previewHistoricalOcr({sourceId:'phone'});assert.deepEqual(images.historicalOcrTargets({token:preview.token}),ids);
 assert.throws(()=>images.processHistoricalOcr({token:preview.token}),{statusCode:409});
 await assert.rejects(f.manual(ids[0],()=>images.processHistoricalOcr({token:preview.token})));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_backfills').get()!.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_backfill_items').get()!.n,0);
 for(const id of ids)assert.equal(f.processing.modelIntent(id,'image'),undefined);
 assert.equal(f.requests.length,0);await f.manual(ids,()=>images.processHistoricalOcr({token:preview.token}));const calls=f.ownerIntentCalls;await images.tick();assert.equal(f.requests.length,2);assert.equal(f.ownerIntentCalls,calls);
});

test('historical preview alone and an empty confirmed selection do not send or acquire authority',async t=>{
 const f=await fixture(t),images=await f.imageProcessor(),preview=images.previewHistoricalOcr({sourceId:'phone'});
 assert.deepEqual(images.historicalOcrTargets({token:preview.token}),[]);images.processHistoricalOcr({token:preview.token});await images.tick();assert.equal(f.requests.length,0);assert.equal(f.ownerIntentCalls,0);
 const id=await f.upload(await sharp({create:{width:4,height:4,channels:3,background:'#aabbcc'}}).png().toBuffer(),'image/png');images.prepare();images.previewHistoricalOcr({sourceId:'phone'});await images.tick();
 assert.equal(f.requests.length,0);assert.equal(f.processing.modelIntent(id,'image'),undefined);assert.equal(f.files.detail(id).hasOriginal,true);assert.equal(f.ownerIntentCalls,0);
});


test('a newer single-image intent supersedes a confirmed historical batch without duplicate sends',async t=>{
 const f=await fixture(t),images=await f.imageProcessor(),id=await f.upload(await sharp({create:{width:4,height:4,channels:3,background:'#314159'}}).png().toBuffer(),'image/png');
 images.prepare();const preview=images.previewHistoricalOcr({sourceId:'phone'});const old=await f.manual(id,()=>images.processHistoricalOcr({token:preview.token}));
 const current=await f.manual(id,()=>images.retry(id,false));assert.notEqual(current,old);const calls=f.ownerIntentCalls;await images.tick();
 assert.equal(f.processing.modelIntent(id,'image'),current);assert.equal(f.requests.length,1);assert.equal(f.ownerIntentCalls,calls);
 assert.equal(f.store.db.prepare('SELECT queued FROM image_backfills').get()!.queued,0);assert.ok(images.detail(id).products.some(p=>p.kind==='ocr'));
});
