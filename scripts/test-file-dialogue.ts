/** Opt-in real local models + real central HTTP protocol, generated audio only. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {FILE_PART_BYTES} from '@mote/shared';
const directory=resolve(process.env.MOTE_FILE_TEST_DIR??'.mote/processing-validation');
const connection=JSON.parse(readFileSync(join(directory,'connection.json'),'utf8'));
assert.equal(connection.server,'http://127.0.0.1:57569');
const audio=readFileSync(resolve(process.argv.slice(2).find(v=>!v.startsWith('--'))??'.mote/processing-validation/generated-interview.wav'));
async function request(path:string,method='GET',value?:unknown){const response=await fetch(connection.server+path,{method,headers:{authorization:'Bearer '+connection.ownerToken,...(value===undefined?{}:{'content-type':Buffer.isBuffer(value)?'application/octet-stream':'application/json'})},body:value===undefined?undefined:Buffer.isBuffer(value)?new Uint8Array(value):JSON.stringify(value)});if(!response.ok)throw Error(path+' '+response.status+' '+await response.text());return response;}
const json=async(path:string,method='GET',value?:unknown)=>(await request(path,method,value)).json() as Promise<any>;
const sourceId='dialogue-'+randomUUID();await json('/api/sources','POST',{id:sourceId,name:'Generated two-speaker interview',kind:'local-files',deviceId:connection.deviceId,platform:'import',retention:'archive'});
const settings=await json('/api/file-processing');
if(process.argv.includes('--policy')){
 const policy=settings.policy,profile=policy.profiles.find((p:any)=>p.processorId==='audio.local-dialogue');
 profile.serviceId='asr-local';profile.parameters={speakerCount:2,semanticTurns:false};
 const service=policy.services.find((s:any)=>s.id==='asr-local');service.endpoint=process.env.MOTE_FILE_TEST_ASR??'http://127.0.0.1:59019/transcribe';service.apiKey=null;
 policy.rules.push({sourceId,type:'audio/*',profileId:profile.id});
 await json('/api/file-processing','PUT',{revision:settings.revision,settings:{...settings.settings,enabled:true},policy});
}else{
 await json('/api/file-processing','PUT',{revision:settings.revision,settings:{...settings.settings,enabled:true,audioProcessor:'archive',sourceProfiles:{...settings.settings.sourceProfiles,[sourceId]:'audio.local-dialogue'},localEndpoint:process.env.MOTE_FILE_TEST_ASR??'http://127.0.0.1:59019/transcribe',localWorkerApiKey:null,speakerCount:2,semanticTurns:false,summarize:false}});
 const health=await json('/api/file-processing/test-local','POST',{});assert.equal(health.diarization,true);
}
const started=await json('/api/file-sync/v1/uploads','POST',{sourceId,sizeBytes:audio.length,sha256:createHash('sha256').update(audio).digest('hex'),item:{externalId:'generated-dialogue.wav',revision:'1',observedAt:new Date().toISOString(),title:'合成多人录音.wav',kind:'file',layer:'original',mimeType:'audio/wav',text:'',deleted:false}});
for(let i=0;i<Math.ceil(audio.length/FILE_PART_BYTES);i++)await request(`/api/file-sync/v1/uploads/${started.uploadId}/parts/${i}`,'PUT',audio.subarray(i*FILE_PART_BYTES,(i+1)*FILE_PART_BYTES));
const ack=await json(`/api/file-sync/v1/uploads/${started.uploadId}/commit`,'POST',{});
let detail:any;const startedAt=Date.now();
while(Date.now()-startedAt<180000){detail=await json('/api/files/'+ack.id);if(['succeeded','failed','blocked'].includes(detail.job.state))break;await new Promise(r=>setTimeout(r,500));}
assert.equal(detail.job.state,'succeeded',JSON.stringify(detail.job));assert.equal(detail.job.local_only,1);if(process.argv.includes('--policy')){assert.equal(detail.processingPolicy.applied.profile.parameters.speakerCount,2);assert.equal(detail.processingPolicy.applied.rule.sourceId,sourceId);}assert.notEqual(detail.job.summary_state,'succeeded');
assert.ok(detail.artifacts.some((a:any)=>a.kind==='transcript'));const diarization=detail.artifacts.find((a:any)=>a.kind==='diarization');assert.equal(diarization.expectedSpeakers,2);assert.equal(diarization.observedSpeakers,2);assert.equal(diarization.samples.length,2);
const chunks=(await json('/api/files/'+ack.id+'/chunks')).items;assert.ok(chunks.length>=2);assert.equal(new Set(chunks.map((r:any)=>r.fileEvidence.speaker).filter((s:string)=>s!=='SPEAKER_UNKNOWN')).size,2);
const original=Buffer.from(await(await request('/api/files/'+ack.id+'/content')).arrayBuffer());assert.deepEqual(original,audio);
const artifact=Buffer.from(await(await request('/api/files/'+ack.id+'/export')).arrayBuffer());writeFileSync(join(directory,'dialogue-export.tar.gz'),artifact,{mode:0o600});
for(const sample of diarization.samples){const value=Buffer.from(await(await request('/api/files/'+ack.id+'/assets?'+new URLSearchParams({artifactId:diarization.id,name:'speaker_samples/'+sample.speaker+'.wav'}))).arrayBuffer());assert.equal(value.subarray(0,4).toString(),'RIFF');}
const report={passed:true,generatedOnly:true,liveLocalAsr:true,liveLocalDiarization:true,cloudModel:false,policyMode:process.argv.includes('--policy'),physicalDevice:false,captureId:ack.id,sourceId,durationMs:diarization.durationMs,observedSpeakers:diarization.observedSpeakers,turns:chunks.length,samples:diarization.samples.length,steps:detail.steps,elapsedMs:Date.now()-startedAt};writeFileSync(join(directory,'dialogue-result.json'),JSON.stringify(report,null,2),{mode:0o600});console.info(JSON.stringify(report));
