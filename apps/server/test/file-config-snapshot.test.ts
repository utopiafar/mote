import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import type {ModelSettings} from '@mote/shared/models';
import type {TranscriptionProvider} from '../src/file-processors.js';

async function fixture(t:any,options:ConstructorParameters<typeof FileProcessing>[3]={},segmentCount=1){
 const dir=mkdtempSync(join(tmpdir(),'mote-file-config-')),store=new Store(dir),sources=new SourceStore(store),files=new FileStore(store,sources);
 sources.register({id:'audio',name:'Generated audio',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
 let begin!:()=>void,finish!:()=>void;const started=new Promise<void>(r=>begin=r),gate=new Promise<void>(r=>finish=r),calls:Parameters<TranscriptionProvider['transcribe']>[0][]=[];
 const provider:TranscriptionProvider={transcribe:async input=>{calls.push(input);begin();await gate;return {durationMs:segmentCount*1000,segments:Array.from({length:segmentCount},(_,i)=>({startMs:i*1000,endMs:(i+1)*1000,text:'Generated immutable transcript '+i}))};}};let processing=new FileProcessing(files,provider,undefined,options);await processing.runtime.ready;
 t.after(async()=>{finish();await processing.close();store.close();rmSync(dir,{recursive:true,force:true});});
 // These snapshot tests exercise the legacy HTTP ASR path; the product default now includes diarization.
 processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true,audioProcessor:'audio.http'}});
 const bytes=Buffer.from('generated audio fixture'),manifest={sourceId:'audio',previousRevision:null,item:{externalId:'generated.wav',revision:'1',observedAt:'2024-01-01T00:00:00.000Z',title:'Generated audio',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false},relativePath:'generated.wav',sizeBytes:bytes.length,sha256:sha256(bytes)};
 const session=files.begin(manifest,()=>{});files.part(session.uploadId,0,bytes,()=>{});const id=(await files.commit(session.uploadId,()=>{})).id;
 return {dir,store,files,get processing(){return processing;},id,calls,started,finish,async restart(){await processing.close();processing=new FileProcessing(files,provider,undefined,options);await processing.runtime.ready;}};
}

test('unrelated image settings preserve an active audio grant and its immutable processing snapshot',async t=>{
 const f=await fixture(t),running=f.processing.tick();await f.started;
 const first=f.processing.engine.list({operationId:'file:'+f.id,kind:'files.pipeline'}).items[0];assert.equal(first.state,'running');
 const old=f.processing.view();f.processing.update({revision:old.revision,settings:{...old.settings,imageEndpoint:'http://127.0.0.1:9030/generated-ocr'}});
 assert.equal(f.calls[0].signal.aborted,false,'unrelated settings must not cancel audio');
 assert.equal(f.processing.engine.get(first.id)!.state,'running');
 f.finish();await running;await f.processing.tick();
 assert.equal(f.calls.length,1);assert.equal(f.files.detail(f.id).job.state,'succeeded');
 assert.equal(f.processing.engine.list({operationId:'file:'+f.id,kind:'files.pipeline'}).items.length,1);
 assert.equal(f.calls[0].settings.imageEndpoint,'','running work keeps its original settings snapshot');
 assert.throws(()=>f.processing.update({revision:old.revision,settings:old.settings}),{statusCode:409});
});

test('relevant audio endpoint changes revoke the active grant and fence its late result',async t=>{
 const f=await fixture(t),running=f.processing.tick();await f.started;
 const first=f.processing.engine.list({operationId:'file:'+f.id,kind:'files.pipeline'}).items[0],old=f.processing.view();
 f.processing.update({revision:old.revision,settings:{...old.settings,endpoint:'http://127.0.0.1:9040/generated-transcribe'}});
 assert.equal(f.calls[0].signal.aborted,true);f.finish();await running;
 assert.notEqual(f.processing.engine.get(first.id)!.state,'succeeded');assert.equal(f.files.chunks(f.id).length,0);
 for(const until=Date.now()+5000;Date.now()<until&&f.files.detail(f.id).job.state!=='succeeded';){await f.processing.tick();if(f.files.detail(f.id).job.state!=='succeeded')await new Promise(r=>setTimeout(r,25));}assert.equal(f.calls.length,2,JSON.stringify({job:f.files.detail(f.id).job,steps:f.processing.engine.list({operationId:'file:'+f.id}).items.map(({kind,state,error,input})=>({kind,state,error,input}))}));assert.equal(f.files.detail(f.id).job.state,'succeeded');assert.equal(f.calls[1].settings.endpoint,'http://127.0.0.1:9040/generated-transcribe');
});

test('same-value saves preserve execution identity and receipts never retain credentials',async t=>{
 const f=await fixture(t),secret='generated-file-snapshot-secret';
 f.processing.update({revision:f.processing.view().revision,settings:{...f.processing.view().settings,apiKey:secret}});
 const firstSettings=f.processing.view().revision,running=f.processing.tick();await f.started;
 const first=f.processing.engine.list({operationId:'file:'+f.id,kind:'files.pipeline'}).items[0];
 f.processing.update({revision:firstSettings,settings:f.processing.view().settings});
 assert.equal(f.calls[0].signal.aborted,false);f.finish();await running;await f.processing.tick();
 assert.equal(f.calls.length,1);assert.equal(f.processing.engine.list({operationId:'file:'+f.id,kind:'files.pipeline'}).items[0].id,first.id);
 const snapshots=f.processing.explain(f.id).snapshots;assert.equal(snapshots.length,1);assert.equal(snapshots[0].settingsRevision,firstSettings);
 assert.ok(!JSON.stringify({view:f.processing.view(),explain:f.processing.explain(f.id),steps:f.processing.engine.list({operationId:'file:'+f.id})}).includes(secret));
 const persisted=f.store.db.prepare('SELECT receipt FROM file_configuration_snapshots').all();assert.ok(!JSON.stringify(persisted).includes(secret));
});

test('legacy global-revision work reuses a compatible successful extraction after reconstruction',async t=>{
 const f=await fixture(t),running=f.processing.tick();await f.started;f.finish();await running;await f.processing.tick();
 const original=f.files.chunks(f.id)[0].id,settings=f.processing.currentSettings(),revision=f.processing.view().revision;
 const legacyKey=[f.files.detail(f.id).sha256,'audio.http','1',settings.endpoint,settings.imageEndpoint,{}];
 f.store.db.prepare("UPDATE file_steps SET fingerprint=? WHERE capture_id=? AND step='extract'").run(sha256(JSON.stringify(legacyKey)),f.id);
 // Generated pre-upgrade durable program: the outer step used the global settings revision.
 f.store.db.prepare("DELETE FROM execution_steps WHERE operation_id=?").run('file:'+f.id);
 f.store.db.prepare("UPDATE file_jobs SET state='waiting',summary_state='waiting',attempts=0,available_at=0 WHERE capture_id=?").run(f.id);
 const legacy=f.processing.engine.enqueue('file:'+f.id,'files.pipeline',{captureId:f.id,revision});
 await f.restart();
 for(const until=Date.now()+5000;Date.now()<until&&f.files.detail(f.id).job.state!=='succeeded';){await f.processing.tick();if(f.files.detail(f.id).job.state!=='succeeded')await new Promise(r=>setTimeout(r,25));}
 assert.equal(f.processing.engine.get(legacy)!.state,'succeeded');assert.equal(f.calls.length,1);assert.equal(f.files.chunks(f.id)[0].id,original);
 assert.equal(f.processing.engine.list({operationId:'file:'+f.id,kind:'files.pipeline'}).items.length,1,'migration must not create a second runnable wrapper');
});

test('restart reconciles a persisted relevant config change before resuming interrupted work',async t=>{
 const f=await fixture(t),running=f.processing.tick();await f.started;
 const saved={revision:randomUUID(),settings:{...f.processing.currentSettings(),endpoint:'http://127.0.0.1:9050/transcribe'}};
 writeFileSync(join(f.dir,'file-processing.json'),JSON.stringify(saved),{mode:0o600});
 await f.restart();f.finish();await running;
 for(const until=Date.now()+5000;Date.now()<until&&f.files.detail(f.id).job.state!=='succeeded';){await f.processing.tick();if(f.files.detail(f.id).job.state!=='succeeded')await new Promise(r=>setTimeout(r,25));}
 assert.equal(f.files.detail(f.id).job.state,'succeeded');assert.equal(f.calls.length,2);assert.equal(f.calls[1].settings.endpoint,saved.settings.endpoint);
 assert.equal(f.files.chunks(f.id).length,1);
});

const generatedModel=(model:string):ModelSettings=>({provider:'custom',protocol:'openai-completions',baseUrl:'http://127.0.0.1:9080',model,reasoningEffort:'auto',maxTokens:1000,modelRequestTimeoutMs:30000,agentTimeoutMs:60000,allowUnauthenticatedLocal:true,apiKey:'generated-model-secret',headers:{},extraBody:{}});
for(const changed of [false,true])test(`summary model snapshot ${changed?'fences a changed model':'survives an unrelated profile save'} across multiple batches`,async t=>{
 let model=generatedModel('model-one'),revision=1,begin!:()=>void,finish!:()=>void;
 const started=new Promise<void>(r=>begin=r),gate=new Promise<void>(r=>finish=r),seen:string[]=[];
 const f=await fixture(t,{analysisSnapshot:()=>model,analysisRevision:()=>revision,analyze:async(records,_prompt,settings)=>{
  seen.push(settings.modelSnapshot!.model);if(seen.length===1){begin();await gate;}
  return {answer:'Generated bounded summary',citations:[{id:records[0].id}]};
 }},41);t.after(()=>finish());
 f.processing.update({revision:f.processing.view().revision,settings:{...f.processing.view().settings,summarize:true}});
 f.finish();const running=f.processing.tick();await started;
 revision++;if(changed)model=generatedModel('model-two');
 finish();await running;
 for(const until=Date.now()+5000;Date.now()<until&&f.files.detail(f.id).job.summary_state!=='succeeded';){await f.processing.tick();if(f.files.detail(f.id).job.summary_state!=='succeeded')await new Promise(r=>setTimeout(r,25));}
 assert.equal(f.files.detail(f.id).job.summary_state,'succeeded');assert.equal(f.calls.length,1,'model settings must not repeat ASR');
 assert.deepEqual(seen,changed?['model-one','model-two','model-two','model-two']:['model-one','model-one','model-one']);
 const summaries=f.processing.engine.list({operationId:'file:'+f.id,kind:'files.summary'}).items;
 assert.equal(summaries.filter(s=>s.state==='succeeded').length,1);assert.equal(summaries.length,changed?2:1);
 assert.ok(!JSON.stringify(f.processing.explain(f.id)).includes('generated-model-secret'));
});

test('snapshot accounting rolls back and forgetting removes configuration receipts',async t=>{
 const f=await fixture(t);f.finish();await f.processing.tick();
 f.store.logicalBytes();const db=f.store.db,bytes=()=>Number(db.prepare("SELECT bytes FROM storage_ledger WHERE name='file_configuration_snapshots'").get()!.bytes);
 assert.ok(bytes()>0);const before=bytes();
 db.exec('BEGIN');db.prepare("INSERT INTO file_configuration_snapshots VALUES(?,?,?)").run(f.id,'generated-extra','{}');assert.equal(bytes(),before+130);db.exec('ROLLBACK');assert.equal(bytes(),before);
 f.files.forget(f.id);assert.equal(bytes(),0);assert.equal(db.prepare('SELECT count(*) AS n FROM file_configuration_snapshots').get()!.n,0);
});
