import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type Plugin} from '@deepseek-ai/cordis';
import {type FilePolicy,type FileRevision} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {type ProcessorInput} from '../src/file-processors.js';
import {buildApp} from '../src/app.js';
import {configFromEnv} from '../src/config.js';

async function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'mote-policy-')),store=new Store(dir,{dataKey:'41'.repeat(32)}),sources=new SourceStore(store),files=new FileStore(store,sources),calls:ProcessorInput[]=[];
 for(const id of ['phone','nas'])sources.register({id,name:id,kind:'local-files',deviceId:id,platform:'android',retention:'archive'});
 const plugin:Plugin={name:'policy-fixture',inject:['moteFileProcessors'],apply(ctx){ctx.effect(()=>ctx.moteFileProcessors.register({id:'fixture.audio',name:'Parameterized ASR',version:'1',stage:'extract',mediaTypes:['audio/'],serviceKind:'asr',parameters:[{key:'speakerCount',label:'人数',type:'number',min:1,max:16,integer:true,default:2}],async process(input){calls.push(input);return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:`Generated speakers ${input.parameters?.speakerCount}`} ]};}}));ctx.effect(()=>ctx.moteFileProcessors.register({id:'fixture.diarize',name:'Generated speakers',version:'1',stage:'diarize',mediaTypes:['audio/'],localOnly:true,async process(input){return {durationMs:1000,engine:'fixture',expectedSpeakers:input.settings.speakerCount,observedSpeakers:2,overlapDetection:'unknown',segments:[{startMs:0,endMs:1000,speaker:'SPEAKER_0'}],samples:[],warnings:[]};}}));}};
 const analyses:any[]=[];const provider={transcribe:async(input:any)=>{calls.push(input);return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Synthetic offline dialogue'}]};}};
 const options={plugins:[plugin],analyze:async(records:any[],prompt:string,settings:any,localOnly:boolean)=>{analyses.push({settings,localOnly});return {answer:'Synthetic summary',citations:[{id:records[0].id}]};}};
 let processing=new FileProcessing(files,provider,undefined,options);await processing.runtime.ready;
 const save=(policy:any=processing.view().policy,settings:any={})=>processing.update({revision:processing.view().revision,settings:{...processing.view().settings,enabled:true,...settings},policy});
 async function upload(name:string,mime='audio/wav',sourceId='phone',layer:'original'|'reference'='original',revision='1',previousRevision:string|null=null){const bytes=Buffer.from('Generated fixture '+name),manifest:FileRevision={sourceId,previousRevision,item:{externalId:name,revision,observedAt:new Date().toISOString(),title:name,kind:'file',layer,text:'',mimeType:mime,deleted:false},relativePath:name,sizeBytes:bytes.length,...(layer==='original'?{sha256:sha256(bytes)}:{})};if(layer==='reference')return (await files.revision(manifest,()=>{})).id;const session=files.begin(manifest,()=>{});files.part(session.uploadId,0,bytes,()=>{});return (await files.commit(session.uploadId,()=>{})).id;}
 t.after(async()=>{await processing.close();store.close();rmSync(dir,{force:true,recursive:true});});
 return {dir,store,files,calls,analyses,save,upload,get processing(){return processing;},async restart(){await processing.close();processing=new FileProcessing(files,provider,undefined,options);await processing.runtime.ready;}};
}
function customPolicy(f:Awaited<ReturnType<typeof fixture>>):FilePolicy{
 const policy=f.processing.view().policy as FilePolicy;
 policy.profiles.push({id:'two',name:'Two speakers',processorId:'fixture.audio',serviceId:'asr-local',parameters:{speakerCount:2},diarizationProcessor:'audio.diarize',summarize:false},{id:'four',name:'Four speakers',processorId:'fixture.audio',serviceId:'asr-local',parameters:{speakerCount:4},diarizationProcessor:'audio.diarize',summarize:false});
 policy.rules.find(r=>r.type==='audio/*')!.profileId='two';policy.rules.push({sourceId:'phone',type:'audio/*',profileId:'four'});return policy;
}

test('migration preserves legacy services and credentials, persists atomically, and keeps legacy clients safe',async t=>{
 const f=await fixture(t),v=f.processing.view();f.processing.update({revision:v.revision,settings:{...v.settings,enabled:true,apiKey:'generated-cloud-secret',localWorkerApiKey:'generated-worker-secret',sourceProfiles:{phone:'audio.local-dialogue'},speakerCount:4}});
 const migrated=f.processing.view();assert.equal(migrated.policyConfigured,false);assert.equal(migrated.policy.rules.find(r=>r.sourceId==='phone')?.type,'audio/*');assert.ok(!JSON.stringify(migrated).includes('generated-'));
 f.save();await f.restart();assert.equal(f.processing.view().policyConfigured,true);assert.equal(f.processing.match({sourceId:'phone',mimeType:'audio/wav'}).profile.parameters.speakerCount,4);
 assert.ok(readFileSync(join(f.dir,'file-processing.json'),'utf8').includes('generated-worker-secret'));
 const current=f.processing.view();assert.throws(()=>f.processing.update({revision:current.revision,settings:{...current.settings,speakerCount:8}}),{statusCode:409});
 f.processing.update({revision:current.revision,settings:{...current.settings,dailyAudioMinutes:300}});assert.equal(f.processing.view().settings.dailyAudioMinutes,300);
});

test('mixed-source routing respects exact MIME, source overrides, global families and archive fallback',async t=>{
 const f=await fixture(t),policy=customPolicy(f);policy.rules.push({sourceId:'phone',type:'audio/mpeg',profileId:'two'},{type:'audio/flac',profileId:'four'});f.save(policy);
 for(const [sourceId,mimeType,expected] of [['phone','audio/wav','four'],['phone','audio/mpeg','two'],['nas','audio/wav','two'],['nas','audio/flac','four'],['phone','text/plain','profile.text.utf8'],['phone','application/pdf','archive'],['phone','application/zip','archive']])assert.equal(f.processing.match({sourceId,mimeType}).profile.id,expected);
 const audio=await f.upload('phone.wav'),text=await f.upload('notes.txt','text/plain'),pdf=await f.upload('scan.pdf','application/pdf');await f.processing.tick();await f.processing.tick();
 assert.equal(f.files.detail(audio).job.state,'succeeded');assert.equal(f.files.detail(text).job.state,'succeeded');assert.equal(f.files.detail(pdf).job.error,'archive_only');assert.equal(f.calls.length,1);
});

test('shared services keep profile parameters and keys isolated through actual Cordis execution',async t=>{
 const f=await fixture(t),policy=customPolicy(f);policy.services.find(s=>s.id==='asr-local')!.apiKey='generated-shared-key';policy.services.find(s=>s.id==='asr-api')!.apiKey='generated-unrelated-key';f.save(policy);
 const phone=await f.upload('four.wav'),nas=await f.upload('two.wav','audio/wav','nas');await f.processing.tick();
 assert.deepEqual(f.calls.map(c=>c.parameters?.speakerCount),[4,2]);assert.deepEqual(f.calls.map(c=>c.settings.speakerCount),[4,2]);assert.ok(f.calls.every(c=>c.settings.apiKey==='generated-shared-key'));assert.ok(!JSON.stringify(f.calls).includes('generated-unrelated-key'));
 assert.equal(f.processing.explain(phone).applied?.profile.id,'four');assert.equal(f.processing.explain(nas).applied?.profile.id,'two');assert.ok(!JSON.stringify(f.processing.explain(phone)).includes('generated-shared-key'));
});

test('policy save rejects incompatible MIME, unknown parameters, bad values, dangling references and duplicate rules',async t=>{
 const f=await fixture(t);f.save(customPolicy(f));
 const attempts=[(p:any)=>p.rules.push({type:'image/png',profileId:'four'}),(p:any)=>p.profiles.find((v:any)=>v.id==='four').parameters.speakerCount=0,(p:any)=>p.profiles.find((v:any)=>v.id==='four').parameters.secret='bad',(p:any)=>p.rules.push({...p.rules[0]}),(p:any)=>p.services.splice(p.services.findIndex((s:any)=>s.id==='asr-local'),1),(p:any)=>p.profiles.find((v:any)=>v.id==='four').processorId='missing.plugin'];
 for(const change of attempts){const p=structuredClone(f.processing.view().policy);change(p);assert.throws(()=>f.save(p));}
 assert.equal(f.processing.match({sourceId:'phone',mimeType:'audio/wav'}).profile.id,'four');
});

test('service credentials are never transferred to changed destinations; local profiles reject cloud bindings',async t=>{
 const f=await fixture(t),policy=customPolicy(f);policy.services.find(s=>s.id==='asr-local')!.apiKey='generated-key';f.save(policy);
 const altered=f.processing.view().policy;altered.services.find(s=>s.id==='asr-local')!.endpoint='http://127.0.0.1:9999/transcribe';assert.throws(()=>f.save(altered),{statusCode:409});(altered.services.find(s=>s.id==='asr-local') as any).apiKey=null;f.save(altered);
 const local=f.processing.view().policy;local.services.push({id:'cloud',name:'Cloud',kind:'asr',endpoint:'https://example.test/transcribe',model:'',execution:'remote',apiKeyConfigured:false});local.profiles.find(p=>p.processorId==='audio.local-dialogue')!.serviceId='cloud';assert.throws(()=>f.save(local),{statusCode:400});
});

test('completed results retain their policy until previewed reprocessing, and stale previews cannot execute',async t=>{
 const f=await fixture(t);f.save(customPolicy(f));const id=await f.upload('sample.wav');await f.processing.tick();const original=f.files.chunks(id)[0].id,revision=f.processing.explain(id).applied!.revision;
 const policy=f.processing.view().policy;policy.profiles.find(p=>p.id==='four')!.parameters.speakerCount=3;f.save(policy);await f.processing.tick();assert.equal(f.calls.length,1);assert.equal(f.files.chunks(id)[0].id,original);assert.equal(f.processing.explain(id).applied!.revision,revision);assert.equal(f.processing.explain(id).current.profile.parameters.speakerCount,3);
 const stale=f.processing.preview({revision:f.processing.view().revision});f.save();assert.throws(()=>f.processing.reprocess({token:stale.token}),{statusCode:409});
 const preview=f.processing.preview({revision:f.processing.view().revision,sourceId:'phone',type:'audio/*'});assert.equal(preview.count,1);assert.equal(f.processing.reprocess({token:preview.token}).queued,1);assert.throws(()=>f.processing.reprocess({token:preview.token}),{statusCode:409});await f.processing.tick();assert.equal(f.calls.length,2);assert.equal(f.calls[1].parameters?.speakerCount,3);assert.notEqual(f.files.chunks(id)[0].id,original);
});

test('batch preview excludes Shadow, archive-only, superseded and active files and rejects changed file states',async t=>{
 const f=await fixture(t);f.save(customPolicy(f));await f.upload('ref.wav','audio/wav','phone','reference');await f.upload('archive.pdf','application/pdf');const old=await f.upload('version.wav');const current=await f.upload('version.wav','audio/wav','phone','original','2','1');const running=await f.upload('running.wav');f.store.db.prepare("UPDATE file_jobs SET state='running' WHERE capture_id=?").run(running);
 const p=f.processing.preview({revision:f.processing.view().revision});assert.deepEqual(p.items.map(x=>x.id),[current]);assert.equal(p.skipped,2);assert.ok(!p.items.some(x=>x.id===old));
 f.processing.retry(current);f.store.db.prepare("UPDATE file_jobs SET attempts=1 WHERE capture_id=?").run(current);assert.throws(()=>f.processing.reprocess({token:p.token}),{statusCode:409});
});

test('local completed files use their original model service for reviews after routing edits and restart',async t=>{
 const f=await fixture(t),p=f.processing.view().policy;const local=p.profiles.find(p=>p.processorId==='audio.local-dialogue')!;local.diarizationProcessor='fixture.diarize';local.parameters.speakerCount=2;local.modelServiceId='llm';p.services.push({id:'llm',name:'Local language model',kind:'model',endpoint:'http://127.0.0.1:8800/v1',execution:'local',model:'generated-model',apiKeyConfigured:false});p.rules.find(r=>r.type==='audio/*')!.profileId=local.id;f.save(p);
 const id=await f.upload('private.wav');await f.processing.tick();assert.equal(f.files.detail(id).job.state,'succeeded');assert.equal(f.files.pendingIndex('cloud').length,0);
 const changed=f.processing.view().policy;changed.rules.find(r=>r.type==='audio/*')!.profileId='profile.audio.http';f.save(changed);await f.restart();await f.processing.analyze(id,f.files.chunks(id),'generated review');assert.equal(f.analyses[0].localOnly,true);assert.equal(f.analyses[0].settings.analysisModel.model,'generated-model');assert.equal(f.files.pendingIndex('cloud').length,0);
 const serviceChanged=f.processing.view().policy;serviceChanged.services.find(s=>s.id==='llm')!.endpoint='http://127.0.0.1:8801/v1';f.save(serviceChanged);await assert.rejects(f.processing.analyze(id,f.files.chunks(id),'review'),{statusCode:409});
});

test('profile-specific summary uses its chosen model and no unrelated credentials',async t=>{
 const f=await fixture(t),p=customPolicy(f);p.services.push({id:'model-api',kind:'model',name:'Profile cloud model',endpoint:'https://example.test/v1',execution:'remote',model:'generated-cloud-model',apiKey:'generated-model-key'});const profile=p.profiles.find(p=>p.id==='four')!;profile.modelServiceId='model-api';profile.summarize=true;f.save(p);
 const id=await f.upload('summary.wav');await f.processing.tick();assert.equal(f.files.detail(id).job.summary_state,'succeeded');assert.equal(f.analyses[0].settings.analysisModel.model,'generated-cloud-model');assert.equal(f.analyses[0].settings.analysisModel.apiKey,'generated-model-key');assert.equal(f.analyses[0].localOnly,false);
});

test('owner policy routes support migration and preview while collector mutation is denied',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-policy-http-')),config={...configFromEnv(),dataDir:dir,token:'generated-owner-policy-token',model:'',apiKey:'',logLevel:'silent' as const};const node=await buildApp(config);t.after(async()=>{await node.app.close();rmSync(dir,{force:true,recursive:true});});
 const owner={authorization:'Bearer '+config.token},get=await node.app.inject({method:'GET',url:'/api/file-processing',headers:owner});assert.equal(get.statusCode,200);const body=get.json();const saved=await node.app.inject({method:'PUT',url:'/api/file-processing',headers:owner,payload:{revision:body.revision,settings:body.settings,policy:body.policy}});assert.equal(saved.statusCode,200);
 const match=await node.app.inject({method:'POST',url:'/api/file-processing/match',headers:owner,payload:{sourceId:'fixture',mimeType:'text/plain'}});assert.equal(match.statusCode,200);assert.equal(match.json().profile.processorId,'text.utf8');
 const {invitation}=node.connections.invite({serverUrl:'http://127.0.0.1:57569',label:'Generated',deviceId:'fixture'});const collector=await node.connections.redeem({code:invitation.code,deviceId:'fixture',deviceName:'Generated',platform:'android'});
 for(const path of ['match','preview','reprocess']){const response=await node.app.inject({method:'POST',url:'/api/file-processing/'+path,headers:{authorization:'Bearer '+collector.token},payload:{}});assert.equal(response.statusCode,403);}
});

test('image and PDF Cordis extensions execute alongside audio with compatible service references',async t=>{
 const f=await fixture(t),seen:string[]=[];
 for(const [id,mime,kind] of [['fixture.image','image/jpeg','image'],['fixture.pdf','application/pdf','file']] as const)f.processing.runtime.registry.register({id,name:id,version:'1',stage:'extract',mediaTypes:[mime],serviceKind:kind,parameters:[{key:'maxPages',label:'页数',type:'number',integer:true,min:1,max:10,default:2}],async process(input){seen.push(input.file.mimeType);assert.equal(input.parameters?.maxPages,2);assert.equal(input.settings.endpoint,'http://127.0.0.1:9900/extract');return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated extraction '+input.file.mimeType}]};}});
 const p=customPolicy(f);for(const [id,kind] of [['fixture.image','image'],['fixture.pdf','file']] as const){p.services.push({id,name:id,kind,execution:'local',endpoint:'http://127.0.0.1:9900/extract',model:''});p.profiles.push({id,name:id,processorId:id,serviceId:id,parameters:{},diarizationProcessor:'audio.diarize',summarize:false});}
 p.rules.push({sourceId:'phone',type:'image/jpeg',profileId:'fixture.image'});p.rules.find(r=>r.type==='application/pdf')!.profileId='fixture.pdf';f.save(p);
 const image=await f.upload('photo.jpg','image/jpeg'),pdf=await f.upload('document.pdf','application/pdf'),audio=await f.upload('recording.wav');await f.processing.tick();await f.processing.tick();
 assert.deepEqual(seen,['image/jpeg','application/pdf']);for(const id of [image,pdf,audio])assert.equal(f.files.detail(id).job.state,'succeeded');assert.equal(f.files.chunks(pdf)[0].fileEvidence?.startMs,undefined);
});

test('temporarily missing Cordis plugins retain configured profiles and block until restored',async t=>{
 const f=await fixture(t);f.save(customPolicy(f));const processor=f.processing.runtime.registry.get('fixture.audio');
 // Simulate a deployment unloading its plugin without deleting user configuration.
 await f.processing.runtime.context.fiber.dispose();await f.processing.runtime.ready;
 f.processing.runtime.registry.register({...processor,id:'fixture.replacement'});
 const p=f.processing.view().policy;assert.doesNotThrow(()=>f.save(p));const id=await f.upload('unavailable.wav');await f.processing.tick();assert.equal(f.files.detail(id).job.state,'blocked');assert.equal(f.files.detail(id).job.error,'processor_not_configured');
 f.processing.runtime.registry.register(processor);f.save();await f.processing.tick();assert.equal(f.files.detail(id).job.state,'succeeded');
});
