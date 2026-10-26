import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createModelAgent} from '../src/model-agent.js';
import {materialId,type MaterialDraft,type MaterialRecord} from '../src/materials.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {FileAttachments,fileAttachmentParent} from '../src/file-attachments.js';
import type {Config} from '../src/config.js';

for(const adapter of ['http','codex'] as const)for(const mutation of ['unchanged','source-declaration','material-owner','deleted-context','unread-body'] as const)test(`${adapter} Memory catalog metadata fences ${mutation} before first model transport`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-catalog-metadata-')),token='generated-catalog-owner';
 let starts=0,node!:Awaited<ReturnType<typeof buildApp>>,pendingMutation:Promise<unknown>|undefined,assembled=false;
 const endpoint=createServer(async(req,res)=>{let body='';for await(const bytes of req)body+=bytes;starts++;
  assert.ok(body.includes('GENERATED_TARGET_BODY'));assert.ok(!body.includes('GENERATED_UNREAD_BODY'));
  assert.ok(!body.includes('memoryCatalogMetadata'),'the private host receipt is never provider input');
  res.writeHead(401,{'Content-Type':'application/json'}).end('{"error":{"message":"Generated refusal"}}');
 });await new Promise<void>(done=>endpoint.listen(0,'127.0.0.1',done));
 const config:Config={dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 const turns=join(directory,'turns.ndjson'),executable=join(directory,'generated-codex.mjs');
 if(adapter==='codex'){
  writeFileSync(join(directory,'auth.json'),JSON.stringify({OPENAI_API_KEY:'generated-unused'}),{mode:0o600});
  writeFileSync(executable,`#!${process.execPath}
import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread',model:null},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){const text=m.params.input[0].text;appendFileSync(${JSON.stringify(turns)},JSON.stringify({hadTarget:text.includes('GENERATED_TARGET_BODY'),hadUnread:text.includes('GENERATED_UNREAD_BODY'),hadPrivate:text.includes('memoryCatalogMetadata')})+'\\n');send({id:m.id,result:{turn:{id:'generated-turn'}}});send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'failed',error:{codexErrorInfo:'unauthorized'}}}});}
});
`,{mode:0o700});Object.assign(config,{modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',codexBin:executable,codexHome:directory});
 }
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(settings,reader,host)=>{
  assert.equal(typeof host?.runModel,'function');assert.equal(typeof host?.authorizeModelRequest,'function');
  return createModelAgent(settings,reader,adapter==='codex'?{executable,home:directory}:undefined,async(task,signal)=>{await pendingMutation;return host!.runModel!(task,signal);},host!.authorizeModelRequest);
 }});await node.app.ready();
 t.after(async()=>{await node.app.close();endpoint.closeAllConnections();await new Promise<void>(done=>endpoint.close(()=>done()));rmSync(directory,{recursive:true,force:true});});
 const ranges:{id:string;offset:number;length:number}[]=[],sourceId='generated-catalog-context';let context!:MaterialRecord,contextDraft!:MaterialDraft,contextParent='';
 for(const name of ['target','context']){
  const source='generated-catalog-'+name,id=randomUUID(),text=name==='target'?'GENERATED_TARGET_BODY retained original.':'GENERATED_UNREAD_BODY retained original.';
  node.sources.register({id:source,name:'Generated '+name,kind:'custom',deviceId:'generated',platform:'import'});
  node.sources.updateContext(source,{expectedVersion:0,description:'Generated '+name+' owner declaration.'});
  await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:text});
  const draft:MaterialDraft={id:materialId(source,name),kind:'mote.note',schemaVersion:1,title:'Generated '+name,origin:{sourceId:source,externalId:name,deviceId:'generated'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[id]}],artifacts:[{key:'source-body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
  const material=node.materials.publish(draft),anchor=node.materials.input(material.ref,['source-body'])!.evidenceIds[0];ranges.push({id:anchor,offset:0,length:text.length});
  if(name==='context'){context=material;contextDraft=draft;contextParent=id;}
 }
 const diagnostics=node.featureServices.diagnostics,trace=diagnostics.agentTrace.bind(diagnostics);
 diagnostics.agentTrace=(event,details)=>{
  if(event.type==='context.assembled'&&!assembled){
   assembled=true;assert.equal((event.payload as {seedEvidence:unknown[]}).seedEvidence.length,1);
   pendingMutation=(async()=>{
    const headers={authorization:'Bearer '+token};
    if(mutation==='source-declaration'){
     const reply=await node.app.inject({method:'PATCH',url:'/api/sources/'+sourceId+'/context',headers,payload:{expectedVersion:1,description:'Generated replacement context declaration.'}});assert.equal(reply.statusCode,200,reply.body);
    }else if(mutation==='material-owner'){
     const reply=await node.app.inject({method:'PATCH',url:'/api/materials/'+context.id+'/context',headers,payload:{expectedRevision:context.revision,ownerRelation:'third_party'}});assert.equal(reply.statusCode,200,reply.body);
    }else if(mutation==='deleted-context'){
     const reply=await node.app.inject({method:'DELETE',url:'/api/captures/'+contextParent,headers});assert.equal(reply.statusCode,200,reply.body);
    }else if(mutation==='unread-body'){
     node.materials.publish({...contextDraft,blocks:contextDraft.blocks.map(block=>({...block,text:'Generated replacement unread body.'}))},{expectedRevision:context.revision});
    }
   })();
  }
  trace(event,details);
 };
 // The public route deliberately does not grant context-only input ranges.
 // This is the same formal host entry used by the explicitly authorized
 // continuation helper; no raw original or unselected source is added.
 const job=node.memoryPipeline.create({evidenceIds:ranges.map(range=>range.id),evidenceRanges:[ranges[0]],contextEvidenceRanges:ranges,recipes:[{id:'mote.personal-memory',version:'5'}]});
 const done=await withFixtureOwnerModelWork(node,()=>node.memoryPipeline.run(job.id));await pendingMutation;assert.equal(assembled,true);
 if(adapter==='codex'){
  const sent=existsSync(turns)?readFileSync(turns,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];starts=sent.length;
  assert.ok(sent.every(row=>row.hadTarget&&!row.hadUnread&&!row.hadPrivate));
 }
 assert.equal(starts,['unchanged','unread-body'].includes(mutation)?1:0,'only already-disclosed metadata is fenced; unread body changes do not retire the independent target');
 assert.equal(done.completedBatches,0);assert.equal(done.memoryIds.length,0);assert.deepEqual(done.batches[0].evidenceRanges,[ranges[0]]);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 if(!['unchanged','unread-body'].includes(mutation)){
  const step=node.store.db.prepare("SELECT state,error,attempts FROM execution_steps WHERE kind='memory.batch' AND operation_id=?").get('memory:'+job.id)!;
  assert.equal(step.error,'context_evidence_restricted');assert.equal(step.attempts,1);
 }
});

test('a complete 4097-member catalog receipt checks metadata without reading body payloads or granting quotes',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-catalog-metadata-full-'));
 const config:Config={dataDir:directory,token:'generated-catalog-full',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:40_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-unused',modelBaseUrl:'https://generated.invalid',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{assert.fail('No model in a metadata fixture');}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const sourceId='generated-catalog-full',id=randomUUID();node.sources.register({id:sourceId,name:'Generated full catalog',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});
 await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated retained body.'});
 const material=node.materials.publish({id:materialId(sourceId,'full'),kind:'mote.note',schemaVersion:1,title:'Generated complete catalog',origin:{sourceId,externalId:'full',deviceId:'generated'},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:Array.from({length:4097},(_,i)=>({id:'line-'+i,kind:'text',format:'plain',text:'Generated '+i,memberIds:[id]})),artifacts:[{key:'source-body',state:'ready',blockIds:Array.from({length:4097},(_,i)=>'line-'+i)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}}),ids=node.materials.input(material.ref,['source-body'])!.evidenceIds;
 const reader=node.featureServices.evidenceReader,receipt=reader.memoryCatalogMetadata({memoryWork:{members:[],contextMembers:[],authorizedMembers:ids.map(id=>({id,materialRef:material.ref,sourceId,attributionContext:material.attributionContext}))}})!;
 assert.equal(receipt.complete,true);assert.equal(receipt.members.length,4097);assert.equal(ids.length,4097);
 const bytes=Buffer.from('Generated attachment body'),file=node.archivedFiles.put({name:'generated.txt',mimeType:'text/plain',bytes});
 const parent=await node.sources.upsert(sourceId,{externalId:'generated-parent',revision:'1',observedAt:'2026-10-01T00:00:00Z',text:'Generated caption',kind:'message',layer:'original',document:{attachments:[{id:file.id,name:file.name,mimeType:file.mimeType}]}});node.archivedFiles.attach(parent.id,[file.id]);
 const child=await new FileAttachments(node.files).prepare(parent.id,file.id,{},()=>{}),artifact=randomUUID(),chunk=randomUUID();
 node.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifact,child.captureId,'text','2026-10-01T00:00:00Z','generated',JSON.stringify({complete:true,coverage:'full'}));
 node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunk,artifact,child.captureId,0,0,'Generated attachment body','{}');
 const attachment=node.materials.publish({id:materialId(sourceId,'generated-attachment'),kind:'mote.message',schemaVersion:1,title:'Generated attachment',origin:{sourceId,externalId:'generated-attachment',deviceId:'generated'},members:[{id:child.captureId,kind:'capture',ref:'capture:'+child.captureId}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated attachment body',memberIds:[child.captureId]}],artifacts:[{key:'source-body',state:'ready',blockIds:['body']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}}),attachmentIds=node.materials.input(attachment.ref,['source-body'])!.evidenceIds;
 const attachmentReceipt=reader.memoryCatalogMetadata({memoryWork:{members:[],contextMembers:[],authorizedMembers:attachmentIds.map(id=>({id,materialRef:attachment.ref,sourceId,attributionContext:attachment.attributionContext}))}})!;
 const originals=node.store.evidence,anchors=node.materials.evidence,text=node.materials.read,canonical=node.memories.readEvidence;
 node.store.evidence=()=>{assert.fail('A catalog guard must not load original bodies');};node.materials.evidence=()=>{assert.fail('A catalog guard must not load anchor bodies');};node.materials.read=()=>{assert.fail('A catalog guard must not read material text');};node.memories.readEvidence=()=>{assert.fail('A catalog guard must not acquire canonical body receipts');};
 try{
  const started=performance.now();assert.equal(reader.memoryCatalogMetadataAllowed(receipt),true);t.diagnostic('Generated 4097-member metadata guard: '+Math.round(performance.now()-started)+' ms');
  assert.equal(reader.memoryCatalogMetadataAllowed(receipt,new EvidenceExposurePolicy([{sourceId,representation:'material',operation:'memory',allow:false}])),false);
  assert.equal(reader.memoryCatalogMetadataAllowed(attachmentReceipt),true,'the existing parent attachment authority is checked without its private body');
  assert.equal(fileAttachmentParent(node.store,child.captureId,true)?.record.id,parent.id);
  assert.equal(node.featureServices.evidenceReader.contextDependenciesAllowed([chunk]),true,'raw dependency metadata also preserves the existing attachment authority without loading either body');
 }finally{node.store.evidence=originals;node.materials.evidence=anchors;node.materials.read=text;node.memories.readEvidence=canonical;}
 node.materials.correctContext(material.id,material.revision,'third_party');assert.equal(reader.memoryCatalogMetadataAllowed(receipt),false,'the next synchronous check has no retained metadata cache');
 node.store.delete(parent.id);assert.equal(reader.memoryCatalogMetadataAllowed(attachmentReceipt),false);assert.equal(fileAttachmentParent(node.store,child.captureId,true),undefined);
});
