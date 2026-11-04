import {join} from 'node:path';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {memoryEvidenceFingerprint} from '../../server/src/memory.js';
import {materialId} from '../../server/src/materials.js';
import sharp from 'sharp';
import {sha256} from '../../server/src/store.js';
import {uploadNoteAttachment} from '../src/plugins/notes/note-attachments.js';
import type {Api} from '../src/api.js';
const directory=process.argv[2];if(!directory)throw Error('Generated fixture directory required');
const token=randomBytes(32).toString('hex'),when='2026-10-29T01:00:00.000Z',noteId=randomUUID(),reportId=randomUUID();
const runtime=await buildApp({dataDir:join(directory,'data'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:process.argv[3]==='memory-ask',query:async()=>{if(process.argv[3]!=='memory-ask')throw Error('No model calls allowed');return {runId:randomUUID(),answer:'Generated controlled original reference answer',citations:[],trace:[]};},close:async()=>{}}});
runtime.app.addHook('onRequest',async(req,reply)=>{
 if(process.argv[3]==='processing'&&req.url==='/api/perception'&&req.method==='PUT'&&existsSync(join(directory,'image-save-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated image settings write unavailable'});
 if(process.argv[3]==='processing'&&req.url==='/api/model-authorization/commands'&&req.method==='POST'&&existsSync(join(directory,'authority-save-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated authority write unavailable'});
 for(const [path,marker] of [['/api/usage?','usage-fault'],['/api/storage-statistics','storage-fault'],['/api/diagnostics','diagnostics-fault']])if(process.argv[3]==='maintenance'&&req.method==='GET'&&req.url.startsWith(path)&&existsSync(join(directory,marker)))return reply.code(503).send({error:'service_unavailable',message:'Generated maintenance read unavailable'});
 if(process.argv[3]==='workspace'&&req.url.includes('/api/model-settings')&&req.url.endsWith('/models'))return reply.send({items:[{id:'generated-model',name:'Generated model catalog'}]});
 if(process.argv[3]==='memory-ask'&&req.url.startsWith('/api/materials/')&&existsSync(join(directory,'advance-material.json'))){const target=JSON.parse(readFileSync(join(directory,'advance-material.json'),'utf8')) as {id:string};const current=runtime.materials.get(target.id)!;runtime.materials.publish({id:target.id,kind:current.kind,schemaVersion:1,title:current.title,origin:current.origin,members:[{id:documentId,kind:'capture',ref:'capture:'+documentId}],blocks:[{id:'body',kind:'text',format:'plain',text:'Changed after the owner selected the pinned Material',memberIds:[documentId]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:current.revision});rmSync(join(directory,'advance-material.json'));}
 if(req.url.startsWith('/api/model-settings/profiles/')&&req.method==='PUT'&&existsSync(join(directory,'model-write-fault')))return reply.code(409).send({error:'model_settings_conflict',message:'Generated model write conflict'});
 if(req.url.startsWith('/api/library/browse?')&&existsSync(join(directory,'retire-material.json'))){const target=JSON.parse(readFileSync(join(directory,'retire-material.json'),'utf8')) as {id:string;revision:string};runtime.materials.retire(target.id,{expectedRevision:target.revision});rmSync(join(directory,'retire-material.json'));}
 if(req.url.startsWith('/api/library/browse?')&&existsSync(join(directory,'catalog-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated catalog read unavailable'});
 if(req.url==='/api/software-update'&&existsSync(join(directory,'version-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated version unavailable'});
 if(req.url==='/api/software-update'&&existsSync(join(directory,'version-mismatch')))return reply.send({currentVersion:'0.0.0-generated'});
 if(req.url==='/api/devices/first-data'&&existsSync(join(directory,'first-data-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated receipt read unavailable'});
 if(req.method==='GET'&&/^\/api\/memories\/[^/?]+(?:\?.*)?$/.test(req.url)&&existsSync(join(directory,'memory-history-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated Memory history unavailable'});
 if(req.url.startsWith('/api/memories/')&&req.url.endsWith('/correct')&&existsSync(join(directory,'memory-correction-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated correction temporarily unavailable'});
 if(req.url.startsWith('/api/memories/')&&req.url.endsWith('/correct')&&existsSync(join(directory,'memory-correction-delay')))await new Promise(resolve=>setTimeout(resolve,700));
 if(req.url.startsWith('/api/memories/')&&req.method==='DELETE'&&existsSync(join(directory,'memory-delete-fault')))return reply.code(403).send({error:'forbidden',message:'Generated Memory delete denied'});
 if(req.url.startsWith('/api/memories/')&&req.url.endsWith('/text')&&existsSync(join(directory,'memory-export-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated Memory export unavailable'});
 if(req.url.includes('/export')&&existsSync(join(directory,'raw-export-fault')))return reply.code(503).send({error:'service_unavailable',message:'Generated raw export unavailable'});
 if(req.url.endsWith('/corrections')&&existsSync(join(directory,'correction-fault')))return reply.code(409).send({error:'conflict',message:'Generated correction conflict'});
 if(req.url.startsWith('/api/captures/')&&req.method==='DELETE'&&existsSync(join(directory,'deny-delete')))return reply.code(403).send({error:'forbidden',message:'Generated original deletion denied'});
 if(req.url==='/api/notes'&&req.method==='POST'&&existsSync(join(directory,'deny-note')))return reply.code(403).send({error:'forbidden',message:'Generated note permission denied'});
});
const headers={authorization:'Bearer '+token};
const invitation=await runtime.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'本轮生成手机'}});
if(invitation.statusCode!==200)throw Error(invitation.body);
const redeemed=await runtime.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android'}});
if(redeemed.statusCode!==200)throw Error(redeemed.body);
const collector={authorization:'Bearer '+redeemed.json().token,'x-mote-ingress-version':'2'};
await runtime.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:collector,payload:{deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android',status:'paused',queueDepth:0}});
const created=await runtime.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:{id:noteId,deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android',capturedAt:when,text:'本轮生成的原始资料：先把资料阅读和提问之间的路径走通，再讨论其他页面。'}});
if(created.statusCode!==201)throw Error(created.body);
runtime.sources.register({id:'generated-home-source',name:'本轮生成资料',kind:'custom',deviceId:'generated-import',platform:'import'});
runtime.sources.reportStatus('generated-home-source',{state:'error',code:'source_adapter_unavailable'});
const imageBytes=await sharp({create:{width:48,height:60,channels:3,background:'#d9c6a2'}}).png().toBuffer();
const imageId=await uploadNoteAttachment({request:async(path:string,init:RequestInit)=>{
 const response=await runtime.app.inject({method:init.method as 'POST'|'PUT',url:path,headers:{...headers,...init.headers},payload:typeof init.body==='string'?JSON.parse(init.body):init.body?Buffer.from(init.body as ArrayBuffer):undefined});
 if(response.statusCode>=400)throw Error(response.body);return response.json();
}} as Api,new File([imageBytes],'本轮生成图片.png',{type:'image/png',lastModified:Date.parse(when)}),'generated-web');
const documentId=(await runtime.sources.upsert('generated-home-source',{externalId:'generated-library-document',revision:'1',observedAt:when,title:'评审议程.md',text:'先检查用户能否找到内容，然后检查能否顺利继续下一步。',kind:'file',layer:'snapshot',mimeType:'text/markdown'})).id;
const materialRefs=[];
for(const [index,title,text] of [[1,'评审议程.md','先检查用户能否找到内容，然后检查能否顺利继续下一步。'],[2,'本轮生成图片.png','这份图片由验收脚本创建，不包含个人资料。']] as const){
 const member=index===2?imageId:index===1?documentId:noteId;
 const material=runtime.materials.publish({id:materialId('generated-home-source',String(index)),kind:index===0?'mote.note':'mote.file',schemaVersion:1,title,origin:{sourceId:'generated-home-source',externalId:String(index),firstAt:when,lastAt:when,deviceId:'generated-phone'},members:[{id:member,kind:'capture',ref:'capture:'+member}],blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[member]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 materialRefs.push(material.ref);
}
// Persist original notes through the same production owner API used by the UI.
if(['library','home-search-questions'].includes(process.argv[3]))for(let index=1;index<(process.argv[3]==='home-search-questions'?32:29);index++){
 const response=await runtime.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:randomUUID(),deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android',capturedAt:when,text:(process.argv[3]==='home-search-questions'?'本轮生成资料记录 ':'本轮生成记录 ')+String(index+1).padStart(2,'0')+'：返回列表应保留筛选、页码、滚动和焦点。'}});
 if(response.statusCode!==201)throw Error(response.body);
}
const citations=[{id:noteId,appName:'本轮生成资料',capturedAt:when,excerpt:'先把资料阅读和提问之间的路径走通。'}];
runtime.store.saveInsight({runId:reportId,answer:'这次评审先看阅读与引用的完整路径。会前有两项准备，需要放在一起核对。',citations,trace:[],artifact:{id:randomUUID(),title:'周五评审前，有两项准备需要对齐',html:'<h1>本轮生成的资料回顾</h1><p>原始资料仍然可读。</p>',createdAt:when,skillId:'generated-fixture',skillVersion:'1'}},reportId);
const conversation=runtime.conversations.append(undefined,{question:'周五评审需要准备什么？'},{runId:randomUUID(),answer:'先核对资料阅读与引用路径。',citations,trace:[]});
const provider={id:'fixture.home-question',version:'1',installationEpoch:'generated-installation',validate:()=>true,answer:()=>({kind:'closed' as const,outcome:'Generated answer acknowledged'})};
runtime.featureServices.ownerQuestions.register(provider);
runtime.featureServices.ownerQuestions.create(provider,{key:'generated-home',operationId:'generated:home',workId:'generated-home',title:'请补充这份资料的背景',prompt:'这份记录来自哪个项目？',evidence:[{id:noteId,quote:'本轮生成的原始资料',offset:0}],choices:[],dependencyIds:[noteId],context:{generated:true}});
for(const title of ['检查资料阅读路径','核对引用返回路径']){const r=await runtime.app.inject({method:'POST',url:'/api/todos',headers,payload:{id:randomUUID(),title,dueAt:null}});if(r.statusCode!==201)throw Error(r.body);}
await runtime.connections.mintMcp({serverUrl:'https://generated.invalid',label:'Generated read-only agent',access:'read'},{directory:join(directory,'connectors'),mcpEnabled:true});
const memoryIds:string[]=[],memoryNoteIds:string[]=[];
if(['workspace','memory-ask','home-search-questions'].includes(process.argv[3])){
 const quote='先把资料阅读和提问之间的路径走通';
 for(let index=0;index<(process.argv[3]==='home-search-questions'?31:3);index++){
  let evidenceId=noteId;if(process.argv[3]==='memory-ask'&&index>0){evidenceId=randomUUID();const response=await runtime.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:evidenceId,deviceId:'generated-web',deviceName:'Generated Web',platform:'import',capturedAt:when,text:'Memory '+index+' '+quote+' distinct generated original'}});if(response.statusCode!==201)throw Error(response.body);}
  const record=runtime.memories.readEvidence([evidenceId])[0],offset=record.ocrText.indexOf(quote);
  const id=randomUUID(),memory={version:1,domain:'personal',tier:'episode',kind:'episodic',id,title:['资料阅读与提问要保留返回路径','阅读优先展示原文与原图','先走通一段完整旅程'][index%3]+(index>=3?' '+index:''),statement:'这次界面讨论要求从原文发起提问、核对引用，并能回到原来的资料列表位置。',uncertainty:'仅来自本轮生成资料，不代表所有使用场景。',status:index===2?'stale':'published',createdAt:when,model:'controlled-fixture',runId:'controlled-fixture',fingerprint:index<9?String(index+1).repeat(64):sha256('generated-memory-'+index),evidenceIds:[evidenceId],evidence:[{id:evidenceId,deviceId:record.deviceId,capturedAt:record.capturedAt,receivedAt:record.receivedAt,offset,length:quote.length,quote,contentHash:memoryEvidenceFingerprint(record)}],admission:{layer:'memory',reason:'Generated visual fixture',scope:'Generated UI validation',attribution:'user'}};
  runtime.store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(id,when,JSON.stringify(memory));runtime.store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(id,evidenceId);memoryIds.push(id);memoryNoteIds.push(evidenceId);
 }
}
if(process.argv[3]==='maintenance'){
 const ledger=runtime.featureServices.usageLedger;
 ledger.setPrice({provider:'generated-fixture',model:'generated-priced',currency:'USD',input:2,output:3,cacheRead:1,cacheWrite:1});
 for(let index=0;index<12;index++){
  const meter=ledger.start('generated-fixture',index%3?'generated-priced':'generated-unpriced','query',{agentId:'context-query',moduleId:['conversations','memories','insights','files','imports'][index%5],skillId:null});
  if(index%4)meter.update({requests:1,reportedRequests:1,inputTokens:1000+index,outputTokens:100,totalTokens:1100+index,cacheReadTokens:0,cacheWriteTokens:0});
  meter.finish(index%5?'completed':'failed');
 }
}
let recordingId:string|undefined;
if(process.argv[3]==='recording'){
 // Generated waveform plus controlled ASR output: no audio/model provider call.
 const waveform=Buffer.alloc(44+8000*2);waveform.write('RIFF');waveform.writeUInt32LE(waveform.length-8,4);waveform.write('WAVEfmt ',8);waveform.writeUInt32LE(16,16);waveform.writeUInt16LE(1,20);waveform.writeUInt16LE(1,22);waveform.writeUInt32LE(8000,24);waveform.writeUInt32LE(16000,28);waveform.writeUInt16LE(2,32);waveform.writeUInt16LE(16,34);waveform.write('data',36);waveform.writeUInt32LE(16000,40);for(let i=0;i<8000;i++)waveform.writeInt16LE(Math.round(Math.sin(i*Math.PI/20)*1000),44+i*2);
 runtime.sources.register({id:'generated-recording',name:'本轮生成录音',kind:'local-files',deviceId:'generated-web',platform:'macos',retention:'archive'});
 const begin=runtime.files.begin({sourceId:'generated-recording',item:{externalId:'recording.wav',revision:'1',observedAt:when,kind:'file',layer:'original',mimeType:'audio/wav',title:'资料阅读讨论.wav'},sizeBytes:waveform.length,sha256:sha256(waveform)},()=>{});runtime.files.part(begin.uploadId,0,waveform,()=>{});recordingId=(await runtime.files.commit(begin.uploadId,()=>{})).id;
 const raw=randomUUID(),dialogue=randomUUID(),diarization=randomUUID();const segments=[{startMs:0,endMs:400,text:'本轮生成的原始转写：先核对资料。',speaker:'SPEAKER_0'},{startMs:400,endMs:800,text:'继续核对返回路径。',speaker:'SPEAKER_0',uncertain:true},{startMs:800,endMs:1000,text:'保留原始录音和转写。',speaker:'SPEAKER_1'}];
 for(const [artifact,kind,value]of [[raw,'transcript',{complete:true,transcript:{durationMs:1000,segments}}],[dialogue,'dialogue',{complete:true,transcript:{durationMs:1000,segments},inputArtifacts:[raw]}],[diarization,'diarization',{durationMs:1000,segments:segments.map(({startMs,endMs,speaker})=>({startMs,endMs,speaker})),samples:[{speaker:'SPEAKER_0'},{speaker:'SPEAKER_1'}],warnings:[],observedSpeakers:2}]] as const){runtime.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifact,recordingId,kind,when,'generated-controlled-ASR',JSON.stringify(value));}
 for(const [index,segment]of segments.entries())runtime.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata,ordinal) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),dialogue,recordingId,segment.startMs,segment.endMs,segment.text,JSON.stringify({speaker:segment.speaker,uncertain:segment.uncertain}),index);
 for(const speaker of ['SPEAKER_0','SPEAKER_1'])runtime.files.saveAsset(diarization,'speaker_samples/'+speaker+'.wav','audio/wav',waveform);
 runtime.store.db.prepare("UPDATE file_jobs SET state='succeeded',summary_state='skipped',error=NULL WHERE capture_id=?").run(recordingId);
}
const questionIds:string[]=[],activeRunIds:string[]=[];let previewNoteId:string|undefined,previewMaterialRef:string|undefined;const previewBody='{"captureId":"这段 JSON 是用户亲写的正文"}';
if(process.argv[3]==='home-search-questions'){
 previewNoteId=randomUUID();const createdPreview=await runtime.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:previewNoteId,deviceId:'generated-phone',deviceName:'本轮生成手机',platform:'android',capturedAt:'2026-10-30T01:00:00.000Z',text:previewBody}});if(createdPreview.statusCode!==201)throw Error(createdPreview.body);await runtime.materialOrganizer.tick();previewMaterialRef=runtime.materials.list({limit:100}).items.find(item=>item.kind==='mote.note'&&item.origin.externalId===previewNoteId)?.ref;if(!previewMaterialRef)throw Error('Generated authored note did not produce its real Material');
 const provider={id:'fixture.final-question',version:'1',installationEpoch:'generated-final',validate:()=>true,answer:(_record:unknown,reply:{action:string})=>reply.action==='unknown'?{kind:'closed' as const,outcome:'本次追问结束，原始资料保留。'}:{kind:'continued' as const,continuationId:'generated-no-model-continuation',outcome:'回答已记录，继续处理状态以实际活动为准。'}};runtime.featureServices.ownerQuestions.register(provider);
 for(let i=0;i<3;i++){const q=runtime.featureServices.ownerQuestions.create(provider,{key:String(i),operationId:'generated:question:'+i,workId:'generated-final-question-'+i,materialId:materialRefs[0].split('@')[0].replace('material:',''),materialRef:materialRefs[0],title:'这份资料里的讲述者是你吗？'+(i?' '+i:''),prompt:'请确认这份资料中，谈到工作安排的是不是你。',reason:'原文没有可靠的身份对应。',evidence:[{id:documentId,quote:'先检查用户能否找到内容',ref:'capture:'+documentId}],choices:[{id:'owner',label:'是我在讲述',answer:'是我在讲述工作安排。'},{id:'other',label:'是其他人',answer:'这段是其他人在讲述。'}],dependencyIds:[documentId],context:{generated:true}});questionIds.push(q.id);if(i===2)runtime.featureServices.ownerQuestions.obsolete(q.id);}
 for(let i=0;i<(process.argv[4]==='no-active-runs'?0:2);i++){const id=randomUUID();runtime.insightRuns.start(id,{},async(_observe,signal)=>new Promise((_resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));activeRunIds.push(id);}
}
await runtime.app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({server:runtime.app.server.address(),token,noteId,reportId,conversationId:conversation.id,materialRefs,memoryIds,memoryNoteIds,questionIds,activeRunIds,previewNoteId,previewMaterialRef,previewBody,recordingId,directory,generatedOnly:true,modelCalls:0}));
process.on('SIGTERM',()=>{void runtime.app.close().then(()=>process.exit(0));});
