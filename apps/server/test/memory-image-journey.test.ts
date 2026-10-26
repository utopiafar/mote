import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {parseAnswer,type QueryInput} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {StoreError,sha256} from '../src/store.js';
import {memoryImageGrants,uninspectedMemoryImageTargets} from '../src/memory-image-grants.js';
import {materialId} from '../src/materials.js';
import {generatedMemoryOutput,planGeneratedMemory} from './fixtures/memory-planning.js';
import {HindsightEngine} from '../src/hindsight-engine.js';
import {taskTools,buildContextEnvelope} from '../../../packages/agent/dist/task-context.js';
import {generatedNativeAdapter} from './fixtures/native-engine-adapter.js';

type Scenario={revokeImagesDuringExtract?:boolean;rewriteReview?:'uncovered'|'covering';deletionReview?:boolean;integration?:boolean;pendingUnderstanding?:boolean;ocr:'text'|'empty'|'failed';automatic?:boolean;denied?:boolean;skipReviewPixels?:boolean;deleteDuringReview?:boolean;replaceDuringReview?:boolean;attributionDuringReview?:boolean;metadataOnly?:boolean;unreadEmpty?:boolean;failFirstReview?:boolean};
async function fixture(t:import('node:test').TestContext,scenario:Scenario){
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-image-journey-')),token='generated-memory-image-owner';
 const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-vision',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 const receipts:{phase:string;ids:string[];views:string[]}[]=[],inputs:QueryInput[]=[];let rawId='',mutated=false,failedReview=false;
 let node!:Awaited<ReturnType<typeof buildApp>>;
 const createModelAgent:ModelAgentFactory=async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  if(input.directImages?.length){await reader.readImage!({id:input.directImages[0].id});return {answer:JSON.stringify({text:'Fallible model interpretation claims the owner drew a red rectangle. Authorship is unverified.',regions:[]}),citations:[],trace:[],runId:randomUUID()};}
  if(await planGeneratedMemory(input))return {answer:'Generated packages submitted.',citations:[],trace:[],runId:randomUUID()};
  inputs.push(input);const phase=input.traceContext?.phase??'extract';
  if(scenario.denied){assert.equal(input.archiveImagesEnabled,false);assert.ok(!taskTools(input).includes('read_image'));assert.equal(buildContextEnvelope(input,[]).authorizedImages,undefined);}
  if(scenario.revokeImagesDuringExtract&&phase==='extract'){assert.equal(input.archiveImagesEnabled,true);await node.perception.save({revision:node.configService.revision,settings:{...node.perception.settings(),allowQueryImages:false}});}
  if(phase==='review'&&scenario.failFirstReview&&!failedReview){failedReview=true;throw new StoreError('Generated independent reviewer stopped',422);}
  const bridge=await startBridge(reader,input);
  try{
   const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});return {status:response.status,body:await response.json() as any};};
   const grant=input.processingImages?.[0];assert.ok(grant,'new formal image task must carry a precise original grant');
   if(scenario.deletionReview&&input.responseMode==='answer'){
    const pixels=await call('read_image',{id:grant.id});assert.equal(pixels.status,200,JSON.stringify(pixels.body));
    bridge.imageDelivery(pixels.body.imageDelivery,true);
    receipts.push({phase:'deletion',ids:bridge.imageReadReceipts.map(receipt=>receipt.id),views:bridge.imageReadReceipts.map(receipt=>receipt.imageView.viewId)});
    return {answer:JSON.stringify({sameConclusion:true,newSupportEvidenceIds:[]}),citations:[],trace:bridge.trace,runId:randomUUID(),imageReadReceipts:bridge.imageReadReceipts,evidenceDependencies:bridge.evidenceDependencies};
   }
   if(input.skill==='memory-integration'){
    const ids=JSON.parse(input.question.slice(input.question.lastIndexOf('\n')+1)) as string[];
    assert.equal(input.evidenceIds,undefined,'open integration retains exact selected image grants without opening whole-library original reads');
    assert.equal(input.processingImages!.length,1);
    const memory=await call('memories',{id:ids[0]});assert.equal(memory.status,200,JSON.stringify(memory.body));assert.equal(memory.body.data.items.length,1);
    const denied=await call('read_image',{id:randomUUID(),view:'metadata'});assert.equal(denied.status,400,'a selected image proof cannot authorize another image UUID');
    const metadata=await call('read_image',{id:grant.id,view:'metadata'});assert.equal(metadata.status,200,JSON.stringify(metadata.body));
    const pixels=await call('read_image',{id:grant.id,expectedImageSha256:metadata.body.imageView.original.sha256,region:{x:0,y:0,width:8,height:8}});assert.equal(pixels.status,200,JSON.stringify(pixels.body));
    bridge.imageDelivery(pixels.body.imageDelivery,true);assert.equal(bridge.imageReadReceipts.length,1);
    receipts.push({phase:'integration',ids:bridge.imageReadReceipts.map(receipt=>receipt.id),views:bridge.imageReadReceipts.map(receipt=>receipt.imageView.viewId)});
    return {answer:'{"memories":[]}',citations:[],trace:bridge.trace,runId:randomUUID(),imageReadReceipts:bridge.imageReadReceipts,evidenceDependencies:bridge.evidenceDependencies};
   }

   const text=bridge.seedEvidence.find(record=>record.ocrText.includes('GENERATED_OCR_TEXT'));
   let memories:any[]=[],incomplete=false;
   if(text&&scenario.ocr==='text')memories=[{title:'Generated article',statement:`The displayed third-party article says its author resigned. [${text.id}]`,uncertainty:'The author is not identified as the owner.',admission:{layer:'observation',reason:'Generated visible article',scope:'This generated image only',attribution:'third_party'},evidenceIds:[text.id],evidence:[{id:text.id,quote:'GENERATED_OCR_TEXT: the article author resigned.'}]}];
   else if(scenario.denied)incomplete=true;
   else if(scenario.skipReviewPixels&&phase==='review')memories=(input.taskContext!.untrustedMemoryDraft as any).memories;
   else if(scenario.unreadEmpty){/* Deliberately invalid model response: no OCR/pixels were inspected. */}
   else {
    const metadata=await call('read_image',{id:grant.id,view:'metadata'});
    if(scenario.revokeImagesDuringExtract)await bridge.failure;
    if(!scenario.denied&&metadata.status!==200)t.diagnostic(JSON.stringify(metadata.body));
    if(!scenario.denied)assert.equal(metadata.status,200,JSON.stringify(metadata.body));
    if(metadata.status!==200)incomplete=true;
    else {
     assert.equal(metadata.body.image,undefined);assert.equal(bridge.imageReadReceipts.length,0,'metadata is never pixel proof');
     if(scenario.metadataOnly)incomplete=true;
     else {
      const rewriting=phase==='review'&&scenario.rewriteReview;
      const pixels=await call('read_image',{id:grant.id,expectedImageSha256:metadata.body.imageView.original.sha256,...(rewriting==='covering'?{}:{region:{x:rewriting==='uncovered'?8:0,y:rewriting==='uncovered'?8:0,width:8,height:8}})});
      assert.equal(pixels.status,200,JSON.stringify(pixels.body));assert.ok(pixels.body.image.data);assert.equal(bridge.imageReadReceipts.length,0,'prepared bytes alone are not a delivery receipt');
      bridge.imageDelivery(pixels.body.imageDelivery,true);
      const view=pixels.body.imageView;
      memories=[{title:'Generated visible shape',statement:`The retained image depicts a red rectangle. [${grant.id}]`,uncertainty:'The creator and event date are unknown; this does not identify an owner preference.',admission:{layer:scenario.integration?'memory':'observation',reason:scenario.integration?'Retain the exact generated reference for the fixture redraw task':'Generated original visual fact',scope:'This generated image only',attribution:'observed'},evidenceIds:[grant.id],evidence:[{id:grant.id,image:{originalSha256:view.original.sha256,viewId:view.viewId}}]}];
      if(rewriting){memories[0].title='Edited generated shape';memories[0].statement=`A red rectangle is visible in the retained image. [${grant.id}]`;}
      if(phase==='review'&&scenario.deleteDuringReview&&!mutated){mutated=true;node.store.delete(rawId);}
      if(phase==='review'&&scenario.attributionDuringReview&&!mutated){mutated=true;const material=node.materials.get(grant.materialId)!;node.materials.correctContext(material.id,material.revision,'third_party');}
      if(phase==='review'&&scenario.replaceDuringReview&&!mutated){mutated=true;const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#0000ff'}}).png().toBuffer();const upload=node.files.begin({sourceId:'generated-memory-image',previousRevision:'1',item:{externalId:'generated.png',revision:'2',observedAt:'2026-10-02T00:00:00Z',kind:'file',layer:'original',mimeType:'image/png',title:'Generated replacement',text:''},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});node.files.part(upload.uploadId,0,bytes,()=>{});await node.files.commit(upload.uploadId,()=>{});}
     }
    }
   }
   let answer=generatedMemoryOutput(input,memories);
   if(incomplete){const value=JSON.parse(answer);value.coverage=value.coverage.map((row:any)=>({...row,state:'incomplete',reason:'Necessary original pixels were not delivered.',candidateIndexes:[]}));answer=JSON.stringify(value);}
   const parsed=parseAnswer(JSON.stringify({answer,citationIds:memories.flatMap(memory=>memory.evidenceIds),imageReadReceipts:[{id:grant.id,imageView:{forged:true}}]}),bridge.records);
   const result={...parsed,trace:bridge.trace,runId:randomUUID(),imageReadReceipts:bridge.imageReadReceipts,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};
   receipts.push({phase,ids:result.imageReadReceipts.map(receipt=>receipt.id),views:result.imageReadReceipts.map(receipt=>receipt.imageView.viewId)});
   return result;
  }finally{await bridge.close();}
 }});
 node=await buildApp(config,{backgroundWorker:false,createModelAgent});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.processing.saveImageDefault({endpoint:'http://127.0.0.1:9011/generated-ocr'});
 node.processing.runtime.registry.get('image.http').process=async()=>{if(scenario.ocr==='failed')throw new StoreError('Generated unsupported OCR response',422);return {durationMs:0,segments:scenario.ocr==='empty'?[]:[{startMs:0,endMs:0,text:'GENERATED_OCR_TEXT: the article author resigned.'}]};};
 await node.perception.save({revision:node.configService.revision,settings:{...node.perception.settings(),allowQueryImages:!scenario.denied}});
 const authorization=(await node.app.inject({url:'/api/model-authorization',headers:{authorization:'Bearer '+token}})).json();
 const consent=await node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers:{authorization:'Bearer '+token},payload:{revision:authorization.authorization.revision,operationId:randomUUID(),action:'authorize',connections:authorization.connections,scope:{sourceIds:null,dataKinds:['text','image','audio','conversation']}}});assert.equal(consent.statusCode,200,consent.body);
 node.sources.register({id:'generated-memory-image',name:'Generated images',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
 if(scenario.automatic){node.memoryRecipeSettings.configure({sourceId:'generated-memory-image',recipes:[{id:'mote.personal-memory',version:'5'}]});const settings=node.lifecycle.settings();settings.extraction.enabled=true;await node.lifecycle.save({revision:node.configService.revision,settings});}
 const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).png().toBuffer();
 const upload=node.files.begin({sourceId:'generated-memory-image',item:{externalId:'generated.png',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',mimeType:'image/png',title:'Generated image',text:''},sha256:sha256(bytes),sizeBytes:bytes.length},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});rawId=String((await node.files.commit(upload.uploadId,()=>{})).id);
 if(!scenario.pendingUnderstanding)await node.perception.tick();for(let i=0;i<30;i++)if(await node.materialOrganizer.tick(100)===0)break;
 const material=node.materials.list({sourceId:'generated-memory-image'}).items[0];assert.ok(material);
 const required=['image-original',...(scenario.ocr==='text'?['extracted-text']:[])],pin=node.materials.input(material.ref,required)!;assert.equal(pin.ready,true);
 const grants=memoryImageGrants(node.store,[pin]);assert.equal(grants.length,1);assert.equal(grants[0].originalSha256,sha256(bytes));
 let jobId:string;
 if(scenario.automatic){node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10);jobId=node.memoryPipeline.list()[0]?.id;assert.ok(jobId,'a fresh accepted image grants one automatic job');}
 else {const response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+token},payload:{evidenceIds:pin.evidenceIds,recipes:[{id:'mote.personal-memory',version:'5'}]}});assert.equal(response.statusCode,202,response.body);jobId=String(response.json().id);}
 return {get node(){return node;},jobId,receipts,inputs,rawId,material,pin,grants,async restart(){await node.app.close();node=await buildApp(config,{backgroundWorker:false,createModelAgent});}};
}

for(const ocr of ['text','empty','failed'] as const)test(`formal generated image intake supports independent Memory proof with ${ocr} OCR`,async t=>{
 const f=await fixture(t,{ocr}),done=await f.node.memoryPipeline.run(f.jobId);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);
 const saved=f.node.memories.get(done.memoryIds[0]);assert.notEqual(saved.admission.attribution,'user');assert.ok(saved.uncertainty.includes('unknown')||saved.uncertainty.includes('not identified'));
 if(ocr==='text'){assert.equal(f.receipts.flatMap(receipt=>receipt.ids).length,0,'sufficient OCR does not force any visual call');assert.ok(saved.evidence[0].quote);}
 else {assert.ok(saved.evidence[0].image);assert.deepEqual(f.receipts.map(receipt=>receipt.phase),['extract','review']);assert.ok(f.receipts.every(receipt=>receipt.ids.length===1),'each independent session must actually receive pixels');assert.equal(saved.evidence[0].image!.region!.width,8);}
});

test('fresh image intake automatically selects original proof rather than interpretation and runs independent visual review once',async t=>{
 const f=await fixture(t,{ocr:'empty',automatic:true}),done=await f.node.memoryPipeline.run(f.jobId);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);
 assert.ok(f.inputs.every(input=>input.processingImages?.length===1));assert.ok(f.inputs.every(input=>!input.processingMaterialInputs?.some(pin=>pin.required.includes('image-understanding'))));
 const count=f.inputs.length;for(let i=0;i<5;i++)await f.node.materialOrganizer.tick(100);await f.node.sourcePipelines.drainMemory(f.node.memoryPipeline,true,10);assert.equal(f.inputs.length,count);assert.equal(f.node.memoryPipeline.list().length,1,'rebuilds spend no second raw-image Memory grant');
});

for(const variant of ['denied','metadataOnly','skipReviewPixels','deleteDuringReview','replaceDuringReview','attributionDuringReview','unreadEmpty'] as const)test(`generated image ${variant} never publishes an unverified visual Memory or successful empty outcome`,async t=>{
 const f=await fixture(t,{ocr:'empty',[variant]:true}),done=await f.node.memoryPipeline.run(f.jobId);assert.notEqual(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,0);assert.equal(f.node.memories.list().length,0);
});

for(const rewriteReview of ['uncovered','covering'] as const)test(`formal visual review rewrites a statement with ${rewriteReview} original pixels`,async t=>{
 const f=await fixture(t,{ocr:'empty',rewriteReview}),done=await f.node.memoryPipeline.run(f.jobId);
 assert.ok(f.receipts.some(receipt=>receipt.phase==='extract'&&receipt.views.length===1));
 assert.ok(f.receipts.some(receipt=>receipt.phase==='review'&&receipt.views.length===1),'the independent reviewer really receives its own pixels');
 if(rewriteReview==='uncovered'){
  assert.notEqual(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,0);assert.equal(f.node.memories.list().length,0);
 }else{
  assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);
  const saved=f.node.memories.get(done.memoryIds[0]);assert.match(saved.statement,/A red rectangle is visible/);assert.equal(saved.evidence[0].image!.region,null);
 }
});

test('a saved visual extraction resumes only independent review after restart with its exact original grant',async t=>{
 const f=await fixture(t,{ocr:'empty',failFirstReview:true}),first=await f.node.memoryPipeline.run(f.jobId);assert.notEqual(first.status,'completed');
 assert.equal(f.inputs.filter(input=>input.traceContext?.phase==='extract').length,1);assert.equal(f.node.memories.list().length,0);
 await f.restart();const done=await f.node.memoryPipeline.retry(f.jobId);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);
 assert.equal(f.inputs.filter(input=>input.traceContext?.phase==='extract').length,1,'restart reuses the durable validated draft, never repeats extraction');
 assert.equal(f.receipts.filter(receipt=>receipt.phase==='review').length,1);assert.equal(f.node.memories.get(done.memoryIds[0]).evidence[0].image!.original.sha256,f.grants[0].originalSha256);
});

test('an OCR read from another image in the same frozen Material pin never assesses an unread image target',async t=>{
 const f=await fixture(t,{ocr:'empty'}),other=randomUUID();await f.node.store.ingest({id:other,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated OCR from a different original.'});
 const draft={id:materialId('generated-memory-image','generated-mixed-proof'),kind:'mote.file',schemaVersion:2,title:'Generated two-original proof',origin:{sourceId:'generated-memory-image',externalId:'generated-mixed-proof'},members:[{id:f.rawId,kind:'capture' as const,ref:'capture:'+f.rawId},{id:other,kind:'capture' as const,ref:'capture:'+other}],blocks:[{id:'original',kind:'text' as const,format:'json',text:'Generated original image locator',memberIds:[f.rawId],locator:{memoryImageOriginal:{captureId:f.rawId,sha256:f.grants[0].originalSha256}}},{id:'ocr',kind:'text' as const,format:'plain',text:'Generated OCR from a different original.',memberIds:[other]}],artifacts:[{key:'image-original',state:'ready' as const,blockIds:['original']},{key:'extracted-text',state:'ready' as const,blockIds:['ocr']}],coverage:{state:'complete' as const},fidelity:{state:'lossless' as const},retention:{original:'retained' as const,policy:'keep'}};
 const material=f.node.materials.publish(draft),pin=f.node.materials.input(material.ref,['image-original','extracted-text'])!,grants=memoryImageGrants(f.node.store,[pin]);assert.equal(grants.length,1);
 const delivered=pin.evidenceIds.map(id=>({id,offset:0,length:f.node.memories.readEvidence([id])[0].ocrText.length})),result={answer:JSON.stringify({memories:[],coverage:[{key:'target',state:'no_candidates',candidateIndexes:[]}]}),citations:[],trace:[],runId:randomUUID()},targets=[{id:grants[0].id,key:'target'}];
 assert.deepEqual(uninspectedMemoryImageTargets(f.node.store,[pin],grants,result,delivered,targets),[grants[0].id]);
 const next=f.node.materials.publish({...draft,blocks:[draft.blocks[0],{...draft.blocks[1],memberIds:[f.rawId]}]},{expectedRevision:material.revision}),same=f.node.materials.input(next.ref,['image-original','extracted-text'])!,sameGrants=memoryImageGrants(f.node.store,[same]);
 const sameReads=same.evidenceIds.map(id=>({id,offset:0,length:f.node.memories.readEvidence([id])[0].ocrText.length}));
 assert.deepEqual(uninspectedMemoryImageTargets(f.node.store,[same],sameGrants,result,sameReads,[{id:sameGrants[0].id,key:'target'}]),[],'actual same-original OCR allows the model to choose whether pixels are needed');
 assert.deepEqual(uninspectedMemoryImageTargets(f.node.store,[same],sameGrants,result,sameReads.filter(range=>range.id===sameGrants[0].id),[{id:sameGrants[0].id,key:'target'}]),[sameGrants[0].id],'OCR readiness without an actual delivered range grants no assessment');
});

test('explicit image-understanding input cannot turn an exact quotation of interpretation JSON into original proof',async t=>{
 const f=await fixture(t,{ocr:'empty'}),material=f.node.materials.get(f.material.id)!,pin=f.node.materials.input(material.ref,['image-understanding'])!;assert.equal(pin.ready,true);
 const record=f.node.memories.readEvidence(pin.evidenceIds)[0],claim={title:'Generated unverified authorship',statement:`The owner drew the rectangle. [${record.id}]`,uncertainty:'Generated attempted interpretation self-certification.',admission:{layer:'memory',reason:'Generated unsupported owner claim',scope:'This generated image',attribution:'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]};
 assert.throws(()=>f.node.memories.extract({answer:JSON.stringify({memories:[claim]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[],runId:randomUUID()},'generated',{validateOnly:true,requireAdmission:true}),{code:'image_evidence'});
 assert.equal(f.node.memories.list().length,0);
});

test('open integration reads only its selected current visual Memory original through the real image bridge',async t=>{
 const f=await fixture(t,{ocr:'empty',integration:true}),done=await f.node.memoryPipeline.run(f.jobId);assert.equal(done.status,'completed',JSON.stringify(done));
 const memory=f.node.memories.get(done.memoryIds[0]);assert.equal(memory.admission.layer,'memory');assert.ok(memory.evidence[0].image);
 // The generated intake has already been explicitly assessed above; this case
 // drives only the separate integration stage, not a second automatic intake.
 f.node.lifecycle.retirePending('extraction',Number(f.node.store.db.prepare('SELECT coalesce(max(seq),0) n FROM artifact_events').get()!.n));
 const requested=await f.node.app.inject({method:'POST',url:'/api/memory-integrations',headers:{authorization:'Bearer generated-memory-image-owner'},payload:{recipe:{id:'mote.memory-integration',version:'2'},inputs:[{id:memory.id,version:memory.version,fingerprint:memory.fingerprint}]}});assert.equal(requested.statusCode,202,requested.body);
 await f.node.lifecycle.tick();const state=f.node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!;assert.equal(state.error,undefined);assert.equal(state.active,undefined);
 assert.equal(f.inputs.filter(input=>input.skill==='memory-integration').length,1);assert.deepEqual(f.receipts.filter(receipt=>receipt.phase==='integration').map(receipt=>receipt.ids),[[memory.evidence[0].id]]);
 const receipt=JSON.parse(String(f.node.store.db.prepare('SELECT json FROM memory_integration_deliveries').get()!.json));assert.deepEqual(receipt.memoryIds,[memory.id]);
});
test('an available original image does not wait for the fallible interpretation service',async t=>{
 const f=await fixture(t,{ocr:'empty',pendingUnderstanding:true}),done=await f.node.memoryPipeline.run(f.jobId);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);
 assert.ok(f.inputs.every(input=>!input.processingMaterialInputs?.some(pin=>pin.required.includes('image-understanding'))));assert.deepEqual(f.receipts.map(receipt=>receipt.phase),['extract','review']);
});

test('bounded deletion review keeps its exact original image grant while interpretation is pending',async t=>{
 const f=await fixture(t,{ocr:'empty',pendingUnderstanding:true,deletionReview:true}),first=await f.node.memoryPipeline.run(f.jobId);assert.equal(first.status,'completed',JSON.stringify(first));
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/memories/'+first.memoryIds[0],headers:{authorization:'Bearer generated-memory-image-owner'}});assert.equal(removed.statusCode,200,removed.body);
 const requested=await f.node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer generated-memory-image-owner'},payload:{evidenceIds:f.pin.evidenceIds,recipes:[{id:'mote.personal-memory',version:'5'}]}});assert.equal(requested.statusCode,202,requested.body);
 const repeated=await f.node.memoryPipeline.run(String(requested.json().id));assert.equal(repeated.status,'completed',JSON.stringify(repeated));assert.equal(repeated.memoryIds.length,0,'the deleted conclusion stays suppressed');
 assert.deepEqual(f.receipts.filter(receipt=>receipt.phase==='deletion').map(receipt=>receipt.ids),[[f.grants[0].id]]);
});

test('actual app native visual preflight retains an empty integration delivery receipt without any remote operation',async t=>{
 const f=await fixture(t,{ocr:'empty',integration:true}),done=await f.node.memoryPipeline.run(f.jobId);assert.equal(done.status,'completed',JSON.stringify(done));
 const memory=f.node.memories.get(done.memoryIds[0]);assert.ok(memory.evidence[0].image);
 let remoteCalls=0,workerStarts=0,nativeCalls=0;
 const engine=new HindsightEngine({directory:join(f.node.featureServices.config.dataDir,'generated-native-preflight'),runtime:{service:async()=>{remoteCalls++;throw Error('Unexpected native service for unsupported visual input');},startWorker:async()=>{workerStarts++;},stopWorker:async()=>{},close:async()=>{}}});
 t.after(()=>engine.close());
 generatedNativeAdapter(f.node,{prepare:async input=>{nativeCalls++;return engine.prepare(input);}});
 f.node.lifecycle.retirePending('extraction',Number(f.node.store.db.prepare('SELECT coalesce(max(seq),0) n FROM artifact_events').get()!.n));
 const before=f.node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!;
 const request=await f.node.app.inject({method:'POST',url:'/api/memory-integrations',headers:{authorization:'Bearer generated-memory-image-owner'},payload:{recipe:{id:'mote.memory-integration',version:'2'},inputs:[{id:memory.id,version:memory.version,fingerprint:memory.fingerprint}]}});assert.equal(request.statusCode,202,request.body);
 await f.node.lifecycle.tick();
 const state=f.node.lifecycle.view().extensions.find(extension=>extension.id==='consolidation')!;assert.equal(state.error,'memory_provider_unsupported_input');assert.equal(state.manualRetryRequired,true);assert.equal(state.cursor,before.cursor);assert.equal(state.active?.id,request.json().id);assert.equal(remoteCalls,0);assert.equal(workerStarts,0);assert.equal(nativeCalls,1);
 const receipt=JSON.parse(String(f.node.store.db.prepare('SELECT json FROM memory_integration_deliveries').get()!.json));assert.deepEqual(receipt.memoryIds,[]);assert.deepEqual(receipt.evidenceIds,[],'local input preparation cannot certify transport delivery');assert.equal(f.inputs.filter(input=>input.skill==='memory-integration').length,0);
 await f.node.lifecycle.tick();assert.equal(nativeCalls,1,'unsupported input is not retried automatically');
});


test('disabled archive pixels still allow OCR-backed Memory extraction and independent review through Central startup',async t=>{
 const f=await fixture(t,{ocr:'text',denied:true}),done=await f.node.memoryPipeline.run(f.jobId);
 assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);
 assert.deepEqual(f.receipts.map(receipt=>receipt.phase),['extract','review']);assert.ok(f.receipts.every(receipt=>receipt.ids.length===0));
 const saved=f.node.memories.get(done.memoryIds[0]);assert.equal(saved.evidence[0].quote,'GENERATED_OCR_TEXT: the article author resigned.');
 assert.equal(f.node.perception.settings().allowQueryImages,false);
});

test('revoking image disclosure during extraction blocks the official task without publication or automatic replay',async t=>{
 const f=await fixture(t,{ocr:'empty',revokeImagesDuringExtract:true}),done=await f.node.memoryPipeline.run(f.jobId);
 assert.equal(done.status,'waiting_for_input',JSON.stringify(done));assert.equal(done.errorCode,'image_disclosure_disabled');
 assert.equal(done.execution?.failure?.code,'image_disclosure_disabled');assert.equal(done.memoryIds.length,0);assert.equal(f.node.memories.list().length,0);
 const count=f.inputs.length;await f.node.memoryPipeline.run(f.jobId);assert.equal(f.inputs.length,count,'a blocked permission refusal spends no automatic replay');
 await f.restart();const restored=f.node.memoryPipeline.get(f.jobId);assert.equal(restored.status,'waiting_for_input');assert.equal(restored.errorCode,'image_disclosure_disabled');
});


test('disabled pixels without sufficient OCR retain an incomplete Memory outcome and no publication',async t=>{
 const f=await fixture(t,{ocr:'empty',denied:true}),done=await f.node.memoryPipeline.run(f.jobId);
 assert.notEqual(done.status,'completed');assert.equal(done.errorCode,'memory_evaluation_incomplete');
 assert.equal(done.memoryIds.length,0);assert.equal(f.node.memories.list().length,0);assert.ok(f.receipts.every(receipt=>receipt.ids.length===0));
});
