/** Verify only an explicitly generated Android report against its isolated loopback node. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const directory=resolve(process.env.MOTE_FILE_TEST_DIR??'.mote/file-validation/final');
const connection=JSON.parse(readFileSync(join(directory,'connection.json'),'utf8'));
assert.equal(connection.server,'http://127.0.0.1:57569');
const android=JSON.parse(readFileSync(join(directory,'android-result.json'),'utf8'));
assert.equal(android.complete,true);assert.equal(android.deviceGenerated,true);
async function request(path:string,body?:unknown,method=body?'POST':'GET'){
 const response=await fetch(connection.server+path,{method,headers:{Authorization:`Bearer ${connection.ownerToken}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
 if(!response.ok)throw new Error(`${path.split('?')[0]} returned HTTP ${response.status}`);return response.json() as Promise<any>;
}
const report:any={device:'Android emulator',deviceGenerated:true,androidRun:android.run,originals:[],referenceCount:0,liveModel:false};
const save=()=>writeFileSync(join(directory,'central-result.json'),JSON.stringify(report,null,2),{mode:0o600});
for(const file of android.initialFiles){
 const response=await fetch(`${connection.server}/api/files/${file.captureId}/content`,{headers:{Authorization:`Bearer ${connection.token}`}});assert.equal(response.status,200);
 const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,file.sizeBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
 report.originals.push({id:file.captureId,title:file.item.title,bytes:bytes.length,sha256:file.sha256});
 if(bytes.length>4*1024*1024){const range=await fetch(`${connection.server}/api/files/${file.captureId}/content`,{headers:{Authorization:`Bearer ${connection.token}`,Range:'bytes=4194299-4194310'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(4194299,4194311));}
}
let cursor:string|null=null;
do{const page=await request('/api/files?'+new URLSearchParams({sourceId:android.referenceSource,limit:'100',...(cursor?{cursor}:{})}));for(const file of page.items){assert.equal(file.hasOriginal,false);assert.equal(file.job,null);}report.referenceCount+=page.items.length;cursor=page.nextCursor;}while(cursor);
assert.equal(report.referenceCount,205);
const missing=await request(`/api/files/${android.retainedAfterSourceDelete}`);assert.equal(missing.hasOriginal,true);
report.initialSync=android.newOnlyThenBackfill;report.phoneOriginalsKept=android.phoneOriginalsKept;report.stagingCleared=android.stagingCleared;report.historyCount=android.historyCount;
report.legacyReferenceUpgraded=android.legacyReferenceUpgraded;report.networkResumeAfterTwoParts=android.networkResumeAfterTwoParts;save();
console.info(JSON.stringify({transport:'passed',originals:report.originals.length,references:report.referenceCount}));

if(process.argv.includes('--live-model')){
 const status=await request('/api/status');assert.equal(status.agent.configured,true);report.model=status.agent.model;
 const settings=await request('/api/file-processing');
 if(process.argv.includes('--policy')){
   const policy=settings.policy;const service=policy.services.find((s:any)=>s.id==='asr-api');service.endpoint=process.env.MOTE_FILE_TEST_ASR??'http://127.0.0.1:59019/transcribe';service.execution='local';service.apiKey=null;
   for(const processorId of ['audio.http','text.utf8']){const profile=policy.profiles.find((p:any)=>p.processorId===processorId);profile.summarize=true;}
   await request('/api/file-processing',{revision:settings.revision,settings:{...settings.settings,enabled:true,dailyAudioMinutes:10},policy},'PUT');
 }else await request('/api/file-processing',{revision:settings.revision,settings:{...settings.settings,enabled:true,audioProcessor:'audio.http',summarize:true,endpoint:process.env.MOTE_FILE_TEST_ASR??'http://127.0.0.1:59019/transcribe',dailyAudioMinutes:10}},'PUT');
 const audio=android.initialFiles.find((f:any)=>f.item.mimeType==='audio/wav');assert.ok(audio);
 const targets=android.initialFiles.filter((f:any)=>/^(audio|text)\//.test(f.item.mimeType));
 const deadline=Date.now()+240000;let details:any[]=[];
 for(;;){details=await Promise.all(targets.map((f:any)=>request(`/api/files/${f.captureId}`)));if(details.every(f=>f.job.state==='succeeded'&&f.job.summary_state==='succeeded'))break;
   if(Date.now()>deadline||details.some(f=>f.job.state==='failed'||f.job.summary_state==='failed')){report.processing=details.map(f=>({id:f.captureId,job:f.job}));save();throw Error('Live file processing did not complete; inspect the credential-free report');}
   await new Promise(r=>setTimeout(r,2000));
 }
 const chunks=await request(`/api/files/${audio.captureId}/chunks`);assert.ok(chunks.items.length>0);assert.ok(chunks.items.every((c:any)=>c.fileEvidence.captureId===audio.captureId&&Number.isFinite(c.fileEvidence.startMs)));
 report.transcript=chunks.items.map((c:any)=>({id:c.id,startMs:c.fileEvidence.startMs,endMs:c.fileEvidence.endMs,text:c.ocrText}));
 report.audioArtifacts=details.find(f=>f.captureId===audio.captureId).artifacts;save();
 console.info(JSON.stringify({transcription:'passed',chunks:chunks.items.length,summary:'passed'}));
 // Wait for all queued source versions before producing durable conclusions, which must be invalidated by later derivations.
 const db=new DatabaseSync(join(directory,'archive','mote.sqlite'),{readOnly:true});
 try{while(Number(db.prepare("SELECT COUNT(*) n FROM file_jobs WHERE state IN ('waiting','running','failed') OR (state='succeeded' AND summary_state IN ('waiting','running','failed'))").get()!.n)>0){if(Date.now()>deadline)throw Error('Other processing layers have not settled');await new Promise(r=>setTimeout(r,2000));}}finally{db.close();}
 report.query=await request('/api/query',{question:'请检索 call.wav，展开它的转写片段，说明谁计划在什么时候交付什么、谁负责评审，以及是否批准了采购。请只根据这份合成电话录音回答，区分计划与完成，引用完整片段 ID。',after:null,before:null,deviceId:connection.deviceId,timeZone:'Asia/Shanghai'});
 save();
 const ids=new Set(chunks.items.map((c:any)=>c.id));assert.ok(report.query.citations.length);assert.ok(report.query.citations.some((c:any)=>ids.has(c.id)));assert.ok(report.query.citations.every((c:any)=>ids.has(c.id)||c.id===audio.captureId));assert.ok(report.query.trace.some((step:any)=>step.tool==='file_chunks'&&step.count===chunks.items.length));
 report.memories=await request('/api/memories/extract',{deviceId:connection.deviceId,timeZone:'Asia/Shanghai'});
 report.layers=await request('/api/layers');report.liveModel=true;report.policyMode=process.argv.includes('--policy');save();
 console.info(JSON.stringify({liveModel:'passed',citations:report.query.citations.length,memories:report.memories.items.length,report:join(directory,'central-result.json')}));
}
