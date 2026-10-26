import {authorizeFixtureModels,withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {materialId,type MaterialDraft} from '../src/materials.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {FileAttachments} from '../src/file-attachments.js';
import {createModelAgent} from '../src/model-agent.js';
import type {Config} from '../src/config.js';

const mutations=['unchanged','deleted-original','owner-declaration','formal-input','after-admission'] as const;
for(const adapter of ['http','codex'] as const)for(const mutation of mutations.filter(value=>adapter==='http'||value!=='after-admission'))test(`${adapter} Memory model transport revalidates a delivered seed after ${mutation}`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-transport-')),token='generated-memory-transport';
 let providerStarts=0,wireHadOriginal=false,node!:Awaited<ReturnType<typeof buildApp>>,changed=false,assembled=false;
 const endpoint=createServer(async(req,res)=>{let body='';for await(const bytes of req)body+=bytes;providerStarts++;wireHadOriginal=body.includes('GENERATED_TRANSPORT_ORIGINAL');
  // A terminal fake response makes transport counting independent of output
  // repair or successful publication. No real provider is contacted.
  res.writeHead(401,{'Content-Type':'application/json'}).end('{"error":{"message":"Generated refusal"}}');
 });await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-provider',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 const turns=join(directory,'generated-turns.ndjson'),executable=join(directory,'generated-codex.mjs');let hooksReceived=false;
 if(adapter==='codex'){
  writeFileSync(join(directory,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused'}),{mode:0o600});
  writeFileSync(executable,`#!${process.execPath}
import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread',model:null},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){appendFileSync(${JSON.stringify(turns)},JSON.stringify({hadOriginal:m.params.input[0].text.includes('GENERATED_TRANSPORT_ORIGINAL')})+'\\n');send({id:m.id,result:{turn:{id:'generated-turn'}}});send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'failed',error:{codexErrorInfo:'unauthorized'}}}});}
});
`,{mode:0o700});Object.assign(config,{modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',codexBin:executable,codexHome:directory});
 }
 node=await buildApp(config,{backgroundWorker:false,...(adapter==='codex'?{createModelAgent:async(settings,reader,host)=>{assert.equal(typeof host?.runModel,'function');assert.equal(typeof host?.authorizeModelRequest,'function');hooksReceived=true;return createModelAgent(settings,reader,{executable,home:directory},host!.runModel,host!.authorizeModelRequest);}}:{})});await node.app.ready();await authorizeFixtureModels(node);
 t.after(async()=>{await node.app.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),sourceId='generated-transport-source';node.sources.register({id:sourceId,name:'Generated transport source',kind:'custom',deviceId:'generated',platform:'import'});
 await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'GENERATED_TRANSPORT_ORIGINAL generated retained text.'});
 const draft:MaterialDraft={id:materialId(sourceId,'generated-paragraphs'),kind:'mote.note',schemaVersion:1,title:'Generated original',origin:{sourceId,externalId:'generated-paragraphs',deviceId:'generated'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:[{id:'body',kind:'text',format:'plain',text:'GENERATED_TRANSPORT_ORIGINAL generated retained text.',memberIds:[id]}],artifacts:[{key:'source-body',state:'ready',revision:'generated-first',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
 const material=node.materials.publish(draft),pin=node.materials.input(material.ref,['source-body'])!;
 const diagnostics=node.featureServices.diagnostics,trace=diagnostics.agentTrace.bind(diagnostics);
 diagnostics.agentTrace=(event,context)=>{
  if(event.type==='context.assembled'){assembled=true;assert.equal((event.payload as {seedEvidence:unknown[]}).seedEvidence.length,1);}
  if(!changed&&mutation!=='unchanged'&&event.type===(mutation==='after-admission'?'model.admitted':'context.assembled')){
   changed=true;
   if(mutation==='deleted-original'||mutation==='after-admission')node.store.delete(id);
   else if(mutation==='owner-declaration')node.materials.correctContext(material.id,material.revision,'third_party');
   else node.materials.publish({...draft,artifacts:[{key:'source-body',state:'ready',revision:'generated-second',blockIds:['body']}]},{expectedRevision:material.revision});
  }
  trace(event,context);
 };
 const created=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+token},payload:{evidenceIds:pin.evidenceIds,recipes:[{id:'mote.personal-memory',version:'5'}]}});assert.equal(created.statusCode,202,created.body);
 const jobId=created.json().id;
 const result=await node.memoryPipeline.run(jobId);assert.equal(assembled,true);assert.notEqual(result.status,'completed');
 if(adapter==='codex'){assert.equal(hooksReceived,true);const native=existsSync(turns)?readFileSync(turns,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];providerStarts=native.length;wireHadOriginal=native.some(turn=>turn.hadOriginal);}
 assert.equal(providerStarts,mutation==='unchanged'?1:0,'a loaded original is never a retained model permission');assert.equal(wireHadOriginal,mutation==='unchanged');
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(result.memoryIds.length,0);
 if(mutation!=='unchanged'){
  assert.equal(changed,true);const step=node.store.db.prepare("SELECT state,error,attempts FROM execution_steps WHERE kind='memory.batch' AND operation_id=?").get('memory:'+jobId)!;
  assert.equal(step.error,'context_evidence_restricted');assert.equal(step.attempts,1,'revocation never becomes a network retry');
 }
});

test('Memory transport guard checks all 4097 frozen anchors once per call and retains exact output/raw policy',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-full-grant-')),config:Config={dataDir:directory,token:'generated-full-grant',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:40_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-unused',modelBaseUrl:'https://generated.invalid',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{throw Error('No model is authorized by this fixture');}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),sourceId='generated-full-grant';node.sources.register({id:sourceId,name:'Generated full grant',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});
 await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated full grant original.'});
 const draft:MaterialDraft={id:materialId(sourceId,'generated-paragraphs'),kind:'mote.note',schemaVersion:1,title:'Generated long original',origin:{sourceId,externalId:'generated-paragraphs',deviceId:'generated'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:Array.from({length:4097},(_,index)=>({id:'line-'+index,kind:'text' as const,format:'plain',text:'Generated '+index,memberIds:[id]})),artifacts:[{key:'source-body',state:'ready',blockIds:Array.from({length:4097},(_,index)=>'line-'+index)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
 const material=node.materials.publish(draft),pin=node.materials.input(material.ref,['source-body'])!,reader=node.featureServices.evidenceReader;
 assert.equal(pin.evidenceIds.length,4097);const records=node.memories.readEvidence(pin.evidenceIds),fingerprints=Object.fromEntries(records.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
 let reads=0,selections=0;const read=node.memories.readEvidence,input=node.materials.input.bind(node.materials);
 node.memories.readEvidence=ids=>{reads++;assert.equal(ids.length,4097);return read(ids);};node.materials.input=(ref,required)=>{selections++;return input(ref,required);};
 const started=performance.now();assert.equal(reader.processingEvidenceAllowed(pin.evidenceIds,fingerprints,[pin]),true);t.diagnostic('Generated 4097-anchor fresh guard: '+Math.round(performance.now()-started)+' ms');assert.equal(reads,1);assert.equal(selections,1,'one current Formal output selection per pin, not one per anchor');
 const deny=new EvidenceExposurePolicy([{sourceId,representation:'material',operation:'memory',allow:false}]);assert.equal(reader.processingEvidenceAllowed(pin.evidenceIds,fingerprints,[pin],deny),false);
 const tail=records.at(-1)!;assert.equal(reader.processingEvidenceAllowed(pin.evidenceIds,{...fingerprints,[tail.id]:'changed'},[pin]),false,'the last actually disclosed context original remains fenced independently of target accounting');
 node.materials.correctContext(material.id,material.revision,'third_party');assert.equal(reader.processingEvidenceAllowed(pin.evidenceIds,fingerprints,[pin]),false,'the next call reads the changed owner declaration afresh');
 node.memories.readEvidence=read;node.materials.input=input;
 const raw=node.memories.readEvidence([id])[0],rawFingerprint={[id]:memoryEvidenceFingerprint(raw)};
 assert.equal(reader.processingEvidenceAllowed([id],rawFingerprint,undefined),true,'an explicit current raw authored grant stays readable');
 assert.equal(reader.processingEvidenceAllowed([id],rawFingerprint,undefined,new EvidenceExposurePolicy([{representation:'capture',operation:'memory',allow:false}])),false);
 node.sources.register({id:'generated-raw-coding',name:'Generated raw Coding',kind:'coding-agent',deviceId:'generated',platform:'import'});
 const codingId=randomUUID();await node.store.ingest({id:codingId,deviceId:'generated',deviceName:'Generated',platform:'import',source:'message',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated historical raw Coding event',provenance:{sourceId:'generated-raw-coding',externalId:'event',revision:'1',layer:'original',document:{coding:{version:1,provider:'codex',projectKey:'generated',sessionId:'generated',eventId:'event',role:'user',attribution:'human',part:0,parts:1}}}});
 const codingRecord=node.memories.readEvidence([codingId])[0];assert.equal(reader.processingEvidenceAllowed([codingId],{[codingId]:memoryEvidenceFingerprint(codingRecord)},undefined),false,'a frozen fingerprint never overrides the hard raw Coding prohibition');
 const bytes=Buffer.from('Generated attachment original'),file=node.archivedFiles.put({name:'generated.txt',mimeType:'text/plain',bytes});
 const parent=await node.sources.upsert(sourceId,{externalId:'attachment-parent',revision:'1',observedAt:'2026-10-01T00:00:00Z',text:'Generated attachment caption',kind:'message',layer:'original',document:{attachments:[{id:file.id,name:file.name,mimeType:file.mimeType}]}});node.archivedFiles.attach(parent.id,[file.id]);
 const child=await new FileAttachments(node.files).prepare(parent.id,file.id,{},()=>{}),artifact=randomUUID(),chunk=randomUUID();
 node.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifact,child.captureId,'text','2026-10-01T00:00:00Z','generated',JSON.stringify({complete:true,coverage:'full'}));
 node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunk,artifact,child.captureId,0,0,'Generated attachment original','{}');
 const attached=node.memories.readEvidence([chunk])[0],attachedFingerprint={[chunk]:memoryEvidenceFingerprint(attached)};assert.equal(reader.processingEvidenceAllowed([chunk],attachedFingerprint,undefined),false,'the declared source route requires Formal Memory input rather than raw attachment text');
 const attachmentMaterial=node.materials.publish({id:materialId(sourceId,'generated-attachment-body'),kind:'mote.message',schemaVersion:1,title:'Generated attachment body',origin:{sourceId,externalId:'generated-attachment-body',deviceId:'generated'},members:[{id:child.captureId,kind:'capture',ref:'capture:'+child.captureId}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated attachment original',memberIds:[child.captureId]}],artifacts:[{key:'source-body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}}),attachmentPin=node.materials.input(attachmentMaterial.ref,['source-body'])!,attachmentRecords=node.memories.readEvidence(attachmentPin.evidenceIds),attachmentFingerprints=Object.fromEntries(attachmentRecords.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
 assert.equal(reader.processingEvidenceAllowed(attachmentPin.evidenceIds,attachmentFingerprints,[attachmentPin]),true);
 const removed=await node.app.inject({method:'DELETE',url:'/api/captures/'+parent.id,headers:{authorization:'Bearer '+config.token}});assert.equal(removed.statusCode,200);assert.equal(reader.processingEvidenceAllowed(attachmentPin.evidenceIds,attachmentFingerprints,[attachmentPin]),false,'a prior Formal attachment grant never survives deletion of its parent');
});

test('HTTP Memory transport fences a context-only original actually disclosed by a tool before the next model request',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-context-transport-')),token='generated-context-transport',events:{type:string;tool?:string;status?:string}[]=[];let node!:Awaited<ReturnType<typeof buildApp>>,starts=0,contextRead=false,revoked=false,contextId='',contextParent='';
 const endpoint=createServer(async(req,res)=>{let raw='';for await(const bytes of req)raw+=bytes;starts++;assert.ok(!raw.includes('processingDisclosedEvidenceIds'),'private disclosure tracking never becomes model input');
  if(starts>1){res.writeHead(401,{'Content-Type':'application/json'}).end('{"error":{"message":"Generated unexpected request"}}');return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  send({id:'generated-context-read',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'generated-context-call',type:'function',function:{name:'context_evidence',arguments:JSON.stringify({id:contextId,offset:0,length:40})}}]},finish_reason:null}]});
  send({id:'generated-context-read',choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});res.end('data: [DONE]\n\n');
 });await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-provider',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 node=await buildApp(config,{backgroundWorker:false});await node.app.ready();await authorizeFixtureModels(node);t.after(async()=>{await node.app.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 const sourceId='generated-context-transport';node.sources.register({id:sourceId,name:'Generated context transport',kind:'custom',deviceId:'generated',platform:'import'});
 const inputs=[] as {id:string;offset:number;length:number}[];
 for(const key of ['target','context']){const id=randomUUID(),text='Generated '+key+' independent original.';if(key==='context')contextParent=id;
  await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:text});
  const material=node.materials.publish({id:materialId(sourceId,'generated-'+key),kind:'mote.note',schemaVersion:1,title:'Generated '+key,origin:{sourceId,externalId:'generated-'+key,deviceId:'generated'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[id]}],artifacts:[{key:'source-body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}}),anchor=node.materials.input(material.ref,['source-body'])!.evidenceIds[0];inputs.push({id:anchor,offset:0,length:text.length});if(key==='context')contextId=anchor;
 }
 const job=await withFixtureOwnerModelWork(node,async()=>node.memoryPipeline.create({evidenceIds:[inputs[0].id,inputs[1].id],evidenceRanges:[inputs[0]],contextEvidenceRanges:inputs,recipes:[{id:'mote.personal-memory',version:'5'}]})),diagnostics=node.featureServices.diagnostics,trace=diagnostics.agentTrace.bind(diagnostics);
 diagnostics.agentTrace=(event,context)=>{events.push({type:event.type,tool:event.tool,status:event.status});if(event.type==='progress'&&event.tool==='context_evidence'&&event.phase==='completed'){contextRead=true;if(!revoked){revoked=true;node.store.delete(contextParent);}}trace(event,context);};
 const done=await withFixtureOwnerModelWork(node,()=>node.memoryPipeline.run(job.id));assert.equal(contextRead,true,JSON.stringify({starts,events,execution:node.store.db.prepare("SELECT state,error FROM execution_steps WHERE kind='memory.batch' AND operation_id=?").all('memory:'+job.id)}));assert.equal(revoked,true);assert.equal(starts,1,'the successful first read revokes the already-loaded context before SDK continuation');assert.equal(done.completedBatches,0);assert.equal(done.memoryIds.length,0);
 assert.deepEqual(node.store.db.prepare("SELECT state,error FROM execution_steps WHERE kind='memory.batch' AND operation_id=?").all('memory:'+job.id).map(row=>({state:row.state,error:row.error})),[{state:'failed',error:'context_evidence_restricted'}]);
});
