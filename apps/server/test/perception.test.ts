import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Store} from '../src/store.js';
import {Perception} from '../src/perception.js';
import {FileProcessorRuntime} from '../src/file-processors.js';
import {MediaAssets,MEDIA_CATALOG} from '../src/media-assets.js';
async function setup(t:any,managed=false){const dir=mkdtempSync(join(tmpdir(),'mote-perception-')),store=new Store(dir),runtime=new FileProcessorRuntime();await runtime.ready;const processor=runtime.registry.get('image.http');let calls=0;processor.process=async()=>{calls++;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'合成中文错误 MODULE_NOT_FOUND'}]};};const assets=managed?new MediaAssets(join(dir,'models')):undefined,p=new Perception(store,runtime,undefined,assets,async()=>true);t.after(async()=>{await p.close();await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});const image=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer();const input={id:randomUUID(),deviceId:'fixture',deviceName:'fixture',platform:'macos',capturedAt:'2026-09-18T00:00:00Z',durationMs:0,source:'screen',appId:'fixture',appName:'fixture',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:image.toString('base64')};return {dir,store,p,runtime,input,calls:()=>calls,assets};}
test('managed OCR waits for model, processes new captures and requires preview for historical captures',async t=>{
 const {dir,store,p,input,calls}=await setup(t,true);assert.equal(p.settings().ocrEndpoint,'http://127.0.0.1:9010/ocr');
 await store.ingest(input);store.db.prepare("UPDATE perception_jobs SET auto_eligible=0 WHERE capture_id=? AND kind='ocr'").run(input.id);
 const newer=randomUUID();await store.ingest({...input,id:newer});await p.tick();assert.equal(calls(),0);
 assert.equal(store.db.prepare("SELECT error FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(newer)!.error,'model_missing');
 const root=join(dir,'models/ocr');for(const name of ['det/inference.onnx','det/inference.yml','rec/inference.onnx','rec/inference.yml']){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'synthetic fixture');}
 writeFileSync(join(root,'complete.json'),JSON.stringify({version:MEDIA_CATALOG.ocr.version}));await p.tick();assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(newer)!.state,'succeeded');assert.equal(calls(),1);
 assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.state,'waiting');
 const preview=p.previewHistoricalOcr();assert.equal(preview.count,1);assert.equal(p.processHistoricalOcr({token:preview.token}).queued,1);await p.tick();assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.state,'succeeded');
});
test('atomic intake, immutable originals, versioned searchable results and cached identical images',async t=>{const {store,p,input,calls}=await setup(t);await store.ingest(input);assert.equal(store.db.prepare('SELECT count(*) n FROM perception_jobs').get()!.n,2);const before=store.db.prepare('SELECT json,fingerprint FROM captures WHERE id=?').get(input.id);p.configure({...p.settings(),ocrEndpoint:'http://127.0.0.1/ocr'});await p.tick();assert.deepEqual(store.db.prepare('SELECT json,fingerprint FROM captures WHERE id=?').get(input.id),before);assert.equal(store.search({query:'中文错误'}).length,1);assert.equal(store.search({query:'错误'}).length,1);assert.equal(store.search({query:'MODULE_NOT_FOUND'}).length,1);assert.equal(store.evidence([input.id])[0].ocrText,'合成中文错误 MODULE_NOT_FOUND');assert.equal((await store.ingest(input)).duplicate,true);await store.ingest({...input,id:randomUUID()});await p.tick();assert.equal(calls(),1);assert.ok(store.updates(0).items.some(i=>i.operation==='supersede'));});
test('semantic schedule is independent and failed processing preserves originals',async t=>{const {store,p,input,runtime,calls}=await setup(t);await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr',semanticEndpoint:'http://localhost/vlm',semanticMode:'batch',batchMinutes:15});await p.tick();assert.equal(calls(),1);p.retry(input.id,'semantic');await p.tick();assert.equal(calls(),2);runtime.registry.get('image.http').process=async()=>{throw Error('private error');};p.configure({...p.settings(),ocrEndpoint:'http://localhost/new-ocr'});p.retry(input.id,'ocr');await p.tick();assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.state,'failed');assert.ok(store.image(input.id));assert.equal(store.evidence([input.id])[0].ocrText,'合成中文错误 MODULE_NOT_FOUND');});
test('external forwarding defaults off and deleted inputs cannot be resurrected',async t=>{const {store,p,input,runtime,calls}=await setup(t);await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'https://fixture.invalid/ocr'});await p.tick();assert.equal(calls(),0);assert.equal(store.db.prepare("SELECT error FROM perception_jobs WHERE kind='ocr'").get()!.error,'external_processing_disabled');p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr'});runtime.registry.get('image.http').process=async()=>{store.delete(input.id);return {durationMs:0,segments:[]};};await p.tick();assert.equal(store.evidence([input.id]).length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM perception_results').get()!.n,0);});

test('portable archive keeps immutable uploads and versioned OCR needed by memory quotes',async t=>{const {store,p,input}=await setup(t);await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr'});await p.tick();const archive=store.exportArchive(4*1024*1024);const other=await setup(t);await other.store.importArchive(archive);assert.equal(other.store.evidence([input.id])[0].ocrText,store.evidence([input.id])[0].ocrText);assert.equal(other.store.search({query:'中文错误'}).length,1);await other.store.importArchive(archive);});
test('restart recovery and manual semantic processing never require an OCR result',async t=>{const {store,p,input,calls}=await setup(t);await store.ingest(input);p.configure({...p.settings(),semanticEndpoint:'http://localhost/vlm'});await p.tick();assert.equal(calls(),0);p.retry(input.id,'semantic');await p.tick();assert.equal(calls(),1);assert.equal(store.evidence([input.id])[0].summary,'合成中文错误 MODULE_NOT_FOUND');assert.equal(store.search({query:'中文错误'}).length,1);});

test('unauthorized external OCR cannot starve local semantic processing',async t=>{const {store,p,input,calls}=await setup(t);await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'https://fixture.invalid/ocr',semanticEndpoint:'http://localhost/vlm',semanticMode:'realtime',batchSize:1});await p.tick();assert.equal(calls(),1);assert.equal(store.evidence([input.id])[0].summary,'合成中文错误 MODULE_NOT_FOUND');});

test('OCR status filters follow central processing without changing upload JSON',async t=>{const {store,p,input}=await setup(t);await store.ingest(input);assert.equal(store.previews({ocrStatus:'pending'}).totalCount,1);assert.equal(store.previews({ocrStatus:'disabled'}).totalCount,0);p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr'});await p.tick();assert.equal(store.previews({ocrStatus:'completed'}).totalCount,1);assert.equal(store.previews({ocrStatus:'pending'}).totalCount,0);});

test('a slow semantic request cannot block later OCR work or cause duplicate OCR for identical images',async t=>{
 const {store,p,input,runtime}=await setup(t);let begin!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{begin=resolve;});const wait=new Promise<void>(resolve=>{release=resolve;});let ocr=0;
 runtime.registry.get('image.http').process=async args=>{if(args.settings.imageEndpoint.includes('vlm')){begin();await wait;}else ocr++;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated result'}]};};
 await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr',semanticEndpoint:'http://localhost/vlm',semanticMode:'realtime',batchSize:1});const running=p.tick();await started;await new Promise(resolve=>setImmediate(resolve));await store.ingest({...input,id:randomUUID()});await p.tick();assert.equal(ocr,1);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM perception_jobs WHERE kind='ocr' AND state='succeeded'").get()!.n,2);release();await running;
});

test('a free OCR slot takes the next distinct image while an earlier image remains slow',async t=>{
 const {store,p,input,runtime}=await setup(t);let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const ids=[input.id,randomUUID(),randomUUID()];let third!:()=>void;const thirdStarted=new Promise<void>(resolve=>{third=resolve;});
 runtime.registry.get('image.http').process=async args=>{if(args.file.id===ids[0])await held;if(args.file.id===ids[2])third();return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated OCR'}]};};
 for(let i=0;i<ids.length;i++){const image=await sharp({create:{width:16,height:16,channels:3,background:['#ff0000','#00ff00','#0000ff'][i]}}).png().toBuffer();await store.ingest({...input,id:ids[i],imageBase64:image.toString('base64')});}
 p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr',concurrency:2,batchSize:3});const running=p.tick();
 try{await Promise.race([thirdStarted,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Free OCR slot stayed idle')),3000);timer.unref();})]);assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(ids[0])!.state,'running');}
 finally{release();await running;}
 assert.equal(store.db.prepare("SELECT COUNT(*) n FROM perception_jobs WHERE kind='ocr' AND state='succeeded'").get()!.n,3);
});

test('changing semantic scheduling preserves an in-flight OCR configuration and result',async t=>{
 const {store,p,input,runtime}=await setup(t);let release!:()=>void,begin!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{begin=resolve;});
 runtime.registry.get('image.http').process=async()=>{begin();await held;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated retained OCR result'}]};};
 await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr'});const run=p.tick();await started;
 p.configure({...p.settings(),semanticMode:'realtime',batchMinutes:5});release();await run;
 assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.state,'succeeded');
 assert.ok(store.search({query:'retained OCR result'}).length);
});


test('configuration cancellation releases an uncooperative plugin and fences its late result',async t=>{
 const {store,p,input,runtime}=await setup(t);let begin!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>{begin=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 runtime.registry.get('image.http').process=async()=>{begin();await held;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Obsolete provider result'}]};};
 await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'http://localhost/old'});const running=p.tick();await started;
 p.configure({...p.settings(),ocrEndpoint:'http://localhost/new'});
 await Promise.race([running,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Cancelled provider held its slot')),1000);timer.unref();})]);
 runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[{startMs:0,endMs:0,text:'Current provider result'}]});
 await p.tick();release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(store.evidence([input.id])[0].ocrText,'Current provider result');
});

test('shared executor shutdown preserves restartable perception work and fences the old plugin',async t=>{
 const {ExecutionEngine}=await import('../src/execution-engine.js');
 const {store,p,input,runtime}=await setup(t);await p.close();
 const engine=new ExecutionEngine(store),first=new Perception(store,runtime,engine);let begin!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>begin=r),held=new Promise<void>(r=>release=r);
 runtime.registry.get('image.http').process=async()=>{begin();await held;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Old interrupted result'}]};};
 await store.ingest(input);first.configure({...first.settings(),ocrEndpoint:'http://localhost/ocr'});first.prepare();const running=engine.tick();await started;
 await engine.close();await first.close();await running;
 assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.state,'waiting');
 const nextEngine=new ExecutionEngine(store),next=new Perception(store,runtime,nextEngine);t.after(async()=>{await nextEngine.close();await next.close();});
 runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[{startMs:0,endMs:0,text:'Recovered current result'}]});
 await next.tick();release();await new Promise(r=>setImmediate(r));assert.equal(store.evidence([input.id])[0].ocrText,'Recovered current result');
});

test('restoring a previous OCR configuration can retry its cancelled execution without waiting for the old plugin',async t=>{
 const {store,p,input,runtime}=await setup(t);let begin!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>begin=r),held=new Promise<void>(r=>release=r);
 runtime.registry.get('image.http').process=async()=>{begin();await held;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Cancelled result'}]};};
 await store.ingest(input);p.configure({...p.settings(),ocrEndpoint:'http://localhost/ocr'});const running=p.tick();await started;
 p.configure({...p.settings(),enabled:false});await running;p.configure({...p.settings(),enabled:true});
 runtime.registry.get('image.http').process=async()=>({durationMs:0,segments:[{startMs:0,endMs:0,text:'New resumed result'}]});
 await p.tick();release();await new Promise(r=>setImmediate(r));assert.equal(store.evidence([input.id])[0].ocrText,'New resumed result');
});

test('managed worker unavailability does not consume attempts and readiness resumes queued captures',async t=>{
 const {store,p:old,runtime,assets,dir,input}=await setup(t,true);await old.close();let ready=false;
 const p=new Perception(store,runtime,undefined,assets,async()=>ready);t.after(()=>p.close());
 const root=join(dir,'models/ocr');for(const name of ['det/inference.onnx','det/inference.yml','rec/inference.onnx','rec/inference.yml']){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'fixture');}
 writeFileSync(join(root,'complete.json'),JSON.stringify({version:MEDIA_CATALOG.ocr.version}));
 await store.ingest(input);
 for(let i=0;i<6;i++){store.db.exec("UPDATE execution_steps SET available_at=0 WHERE error='ocr_worker_unavailable'");store.db.exec("UPDATE perception_jobs SET available_at=0 WHERE error='ocr_worker_unavailable'");await p.tick();}
 const job=()=>store.db.prepare("SELECT state,error,attempts FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!;
 assert.equal(job().error,'ocr_worker_unavailable');assert.equal(job().attempts,0);
 ready=true;await p.tick();assert.equal(job().state,'succeeded');assert.equal(job().attempts,1);
});

test('first healthy worker recovers exhausted legacy failures but leaves historical jobs and repeated errors alone',async t=>{
 const {store,p:old,runtime,assets,dir,input}=await setup(t,true);await old.close();let ready=false;
 const p=new Perception(store,runtime,undefined,assets,async()=>ready);t.after(()=>p.close());
 const root=join(dir,'models/ocr');for(const name of ['det/inference.onnx','det/inference.yml','rec/inference.onnx','rec/inference.yml']){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'fixture');}
 writeFileSync(join(root,'complete.json'),JSON.stringify({version:MEDIA_CATALOG.ocr.version}));
 const historical=randomUUID();await store.ingest(input);await store.ingest({...input,id:historical});
 store.db.prepare("UPDATE perception_jobs SET auto_eligible=0 WHERE capture_id=?").run(historical);
 p.prepare();store.db.exec("UPDATE execution_steps SET state='failed',attempts=4,error='processor_failed' WHERE kind='perception.ocr'");
 store.db.exec("UPDATE perception_jobs SET state='failed',attempts=4,error='processor_failed' WHERE kind='ocr'");
 await p.tick();assert.equal(store.db.prepare("SELECT attempts FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.attempts,4);
 ready=true;await p.tick();assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.state,'succeeded');
 assert.equal(store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(historical)!.state,'failed');
 store.db.prepare("UPDATE perception_jobs SET state='failed',attempts=4,error='processor_failed' WHERE capture_id=? AND kind='ocr'").run(input.id);
 await p.tick();assert.equal(store.db.prepare("SELECT attempts FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(input.id)!.attempts,4);
});
