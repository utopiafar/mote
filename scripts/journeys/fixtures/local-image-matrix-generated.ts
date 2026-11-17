/** Explicit remaining IMG-08 generated matrix cases. No A rerun, live model,
 * device claim, second PluginHost or manually acknowledged image delivery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {sha256} from '../../../apps/server/src/evidence-store.js';
import {generatedImageCentral,modelText,pixels,toolResult,type Image,type ModelRequest,type Reply} from './local-image-central-generated.js';

function envelope(body:ModelRequest):any{
 for(const message of body.messages)if(message.role==='user')try{const value=JSON.parse(modelText(message.content));if(typeof value.taskId==='string'&&typeof value.request==='string')return value;}catch{/* Separate image handle or history text. */}
 assert.fail('Missing actual Host envelope');
}
function imagePlan(image:Image,model:string,kind:'answer'|'interpretation',region?:{x:number;y:number;width:number;height:number}){
 return async(body:ModelRequest):Promise<Reply>=>{
  assert.equal(body.model,model);const direct=envelope(body).directImages;assert.equal(direct?.length,1);
  const id=direct[0].id,tools=body.messages.filter(message=>message.role==='tool');
  if(!tools.length){assert.equal(pixels(body).length,0);return {tool:'read_image',args:{id,view:'metadata'}};}
  const view=toolResult(body).imageView;assert.equal(view.original.sha256,sha256(image.bytes));
  if(tools.length===1){assert.equal(pixels(body).length,0);return {tool:'read_image',args:{id,expectedImageSha256:view.original.sha256,...(region?{region}:{})}};}
  const delivered=pixels(body);assert.equal(delivered.length,1);
  if(region){const expected=await sharp(image.bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height}).removeAlpha().raw().toBuffer();assert.equal(sha256(await sharp(delivered[0]).removeAlpha().raw().toBuffer()),sha256(expected));}
  else{assert.equal(delivered[0].length,image.bytes.length);assert.equal(sha256(delivered[0]),sha256(image.bytes));}
  return {json:{answer:kind==='interpretation'?JSON.stringify(image.interpretation):`The generated original and requested view were inspected. [${id}]`,citationIds:[id]}};
 };
}

test('IMG08 matrix 1: enabled but missing model never sends pixels to the selected configured model',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);f.select(()=>assert.fail('Missing local weights cannot authorize configured-model fallback'));
 await f.enable(true);
 assert.equal((await f.node.featureServices.mediaAssets.status('local-image')).state,'not_installed');
 assert.notEqual((await f.api('GET','/api/local-image-processing')).state,'ready');
 const image=f.images.find(image=>image.id==='empty-ocr')!,id=await f.upload(image),detail=await f.api('GET','/api/images/'+id);
 assert.equal(detail.products.some((value:any)=>value.kind==='understanding'),false);
 assert.equal((await f.api('GET','/api/captures/'+id)).id,id);assert.equal(f.runs.length,0);assert.equal((await f.workerRequests()).length,0);
});

test('IMG08 matrix 1: disabling local intake reaches the selected file model through real SDK image transport',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t),image=f.images.find(image=>image.id==='large')!;
 f.select(imagePlan(image,'generated-img08-file','interpretation'));await f.enable(false);
 const id=await f.upload(image),detail=await f.api('GET','/api/images/'+id);
 assert.equal(detail.products.find((value:any)=>value.kind==='understanding')?.text,image.interpretation.text);
 assert.equal((await f.workerRequests()).length,0);assert.equal(f.runs.length,1);assert.equal(f.runs[0].model,'generated-img08-file');assert.equal(f.runs[0].images.length,1);
 assert.equal(f.node.modelSettings.select('chat').settings.model,'generated-img08-ask');assert.equal(f.node.modelSettings.select('memory').settings.model,'generated-img08-memory');
});

test('IMG08 matrix 1: an owned worker crash cannot change local intake into a configured-model call',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);f.select(()=>assert.fail('Worker failure cannot authorize configured-model fallback'));
 await f.prepare();await f.enable(true);
 const pid=await f.pid(),run=promisify(execFile),command=(await run('ps',['-p',String(pid),'-o','command='])).stdout,group=Number((await run('ps',['-p',String(pid),'-o','pgid='])).stdout.trim());
 assert.ok(command.includes(f.directory),'fault injection may target only this exact generated private profile');assert.equal(group,pid,'the generated worker must own its isolated process group');
 process.kill(-pid,'SIGKILL');
 const image=f.images.find(image=>image.id==='empty-ocr')!,id=await f.upload(image),detail=await f.api('GET','/api/images/'+id),worker=await f.workerRequests();
 assert.equal(f.runs.length,0);assert.equal((await f.api('GET','/api/captures/'+id)).id,id);
 if(detail.products.some((value:any)=>value.kind==='understanding'))assert.ok(worker.some(value=>value.captureId===id),'local recovery must produce a real fresh local interpretation');
 else assert.notEqual(detail.jobs.find((value:any)=>value.name==='understanding')?.state,'succeeded');
});

test('IMG08 matrix 2: screenshots, imported files, synced files and retained attachments use the default local producer',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);f.select(()=>assert.fail('Enabled local intake never calls another model'));
 await f.prepare();await f.enable(true);
 await f.api('POST','/api/sources',{id:'generated-img08-sync',name:'Generated sync',kind:'local-files',deviceId:'generated-img08-device',platform:'import',retention:'archive'});
 await f.api('POST','/api/sources',{id:'generated-img08-parent',name:'Generated attachment parent',kind:'upload',deviceId:'generated-img08-device',platform:'import',retention:'archive'});
 const chosen=['photo','small-text','long-image','empty-ocr'].map(id=>f.images.find(image=>image.id===id)!);
 await f.screen(chosen[0]);await f.upload(chosen[1]);await f.upload(chosen[2],{sourceId:'generated-img08-sync'});
 // Native acquisition of attachment bytes is the generated platform boundary.
 // The real default archive owner and public source-item consumer retain them.
 const attachment=f.node.archivedFiles.put({name:'generated-reference.png',mimeType:chosen[3].mimeType,bytes:chosen[3].bytes});
 const parent=await f.api('PUT','/api/sources/generated-img08-parent/items',{externalId:'generated-caption',revision:'1',observedAt:'2026-11-17T00:00:00Z',kind:'message',layer:'original',title:'Generated retained reference',text:'Generated caption',document:{contentRole:'reference',timeBasis:'unknown',attachments:[{id:attachment.id,mimeType:chosen[3].mimeType}]}});
 f.node.archivedFiles.attach(parent.id,[attachment.id]);await f.settle();
 const worker=await f.workerRequests();assert.equal(worker.length,4);assert.equal(f.runs.length,0);
 for(const image of chosen){const request=worker.find(value=>value.originalSha256===sha256(image.bytes));assert.ok(request);const detail=await f.api('GET','/api/images/'+request.captureId);assert.equal(detail.products.find((value:any)=>value.kind==='understanding')?.text,image.interpretation.text);}
 assert.ok((await f.api('GET',`/api/captures/${parent.id}/archived-files`)).items.some((value:any)=>value.id===attachment.id));
});

test('IMG08 matrix 3: generated photo, small text, long raster and wordless originals retain independent OCR and local interpretation',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);f.select(()=>assert.fail('Local interpretation cannot use another model'));await f.prepare();await f.enable(true);
 for(const name of ['photo','small-text','long-image','empty-ocr']){const image=f.images.find(image=>image.id===name)!,id=await f.upload(image),detail=await f.api('GET','/api/images/'+id);assert.equal(detail.products.find((value:any)=>value.kind==='understanding')?.text,image.interpretation.text);assert.equal((await f.api('GET','/api/captures/'+id)).id,id);}
 f.failOcr();const image=f.images.find(image=>image.id==='region-crop')!,id=await f.upload(image),states:any[]=[];let detail=await f.api('GET','/api/images/'+id),last='';
 // This fixture drives the ordinary background tick. A 503 first preserves an
 // unknown physical outcome; a single immediate tick is not a settled result.
 for(;;){const state=JSON.stringify({wait:detail.wait,jobs:detail.jobs});if(state!==last){states.push(JSON.parse(state));last=state;}if(detail.products.some((value:any)=>value.kind==='understanding'))break;assert.equal(detail.jobs.some((value:any)=>value.name==='understanding'&&['failed','cancelled'].includes(value.state)),false,JSON.stringify(detail));await delay(10,undefined,{signal:t.signal});await f.settle();detail=await f.api('GET','/api/images/'+id);}
 t.diagnostic(JSON.stringify({stage:'generated-img08-ocr-503',captureId:id,states,detail,workerRequests:await f.workerRequests()}));
 assert.equal(detail.products.some((value:any)=>value.kind==='ocr'),false);assert.equal(detail.products.find((value:any)=>value.kind==='understanding')?.text,image.interpretation.text);assert.equal((await f.api('GET','/api/captures/'+id)).id,id);assert.equal(f.runs.length,0);
});

test('IMG08 matrix 3: definite HTTP OCR rejection leaves the original and local understanding independently available',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);f.select(()=>assert.fail('A failed OCR stage cannot change the selected understanding model'));await f.prepare();await f.enable(true);f.failOcr(422);
 const image=f.images.find(image=>image.id==='large')!,id=await f.upload(image),detail=await f.api('GET','/api/images/'+id);
 assert.equal(detail.jobs.find((value:any)=>value.name==='ocr')?.state,'failed');assert.equal(detail.products.some((value:any)=>value.kind==='ocr'),false);assert.equal(detail.products.find((value:any)=>value.kind==='understanding')?.text,image.interpretation.text);
 assert.equal((await f.api('GET','/api/captures/'+id)).id,id);const worker=await f.workerRequests();assert.equal(worker.length,1);assert.equal(worker[0].originalSha256,sha256(image.bytes));assert.equal(f.runs.length,0);
 t.diagnostic(JSON.stringify({stage:'generated-img08-ocr-422',detail,workerRequests:worker}));
});

test('IMG08 matrix 2: saved source and batch model choices survive local precedence and are used after disable',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);await f.prepare();await f.enable(true);
 await f.api('POST','/api/sources',{id:'generated-img08-overrides',name:'Generated override source',kind:'local-files',deviceId:'generated-img08-device',platform:'import',retention:'archive'});
 const snapshot=f.node.processing.configurationSnapshot(),baseUrl=(await f.api('GET','/api/model-settings')).settings.baseUrl;
 for(const id of ['generated-source-image','generated-batch-image']){snapshot.policy.services.push({id,name:id,kind:'model',execution:'local',endpoint:baseUrl,model:id,apiKey:'generated-img08-selected-model'});snapshot.policy.profiles.push({...snapshot.policy.profiles.find(value=>value.id==='central-image')!,id,name:id,modelServiceId:id});}
 snapshot.policy.rules.unshift({sourceId:'generated-img08-overrides',type:'image/*',profileId:'generated-source-image'});
 await f.api('PUT','/api/file-processing',{revision:f.node.processing.view().revision,...snapshot});
 const before=f.node.processing.configurationSnapshot(),models=f.node.modelSettings.view();
 f.select(()=>assert.fail('The enabled local selection takes precedence without erasing saved choices'));
 await f.upload(f.images.find(image=>image.id==='small-text')!,{sourceId:'generated-img08-overrides'});
 await f.upload(f.images.find(image=>image.id==='long-image')!,{processingProfileId:'generated-batch-image'});
 assert.equal((await f.workerRequests()).length,2);assert.equal(f.runs.length,0);
 await f.enable(false);
 const samples=new Map([['generated-source-image',f.images.find(image=>image.id==='photo')!],['generated-batch-image',f.images.find(image=>image.id==='empty-ocr')!]]);
 f.select((body,step)=>{const image=samples.get(body.model);assert.ok(image,'use exactly the saved source or batch model');return imagePlan(image,body.model,'interpretation')(body);});
 await f.upload(samples.get('generated-source-image')!,{sourceId:'generated-img08-overrides'});
 await f.upload(samples.get('generated-batch-image')!,{processingProfileId:'generated-batch-image'});
 assert.deepEqual(f.runs.map(run=>run.model).sort(),[...samples.keys()].sort());assert.equal((await f.workerRequests()).length,2);
 await f.enable(true);assert.deepEqual(f.node.processing.configurationSnapshot(),before);assert.deepEqual(f.node.modelSettings.view(),models);
});

test('IMG08 matrix 2: current authorization, source exclusion, archive-only and understanding-off constrain the default plugin',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);f.select(()=>assert.fail('A restrictive intake policy cannot select another model'));await f.prepare();await f.enable(true);
 const command=async(action:'on'|'off'|'exclude',extra:Record<string,unknown>={})=>{const view=await f.api('GET','/api/model-authorization');return f.api('POST','/api/model-authorization/commands',{revision:view.authorization.revision,operationId:randomUUID(),action,...extra});};
 await command('off');const first=await f.upload(f.images.find(image=>image.id==='photo')!);
 assert.equal((await f.api('GET','/api/images/'+first)).products.some((value:any)=>value.kind==='understanding'),false);
 await f.api('POST','/api/sources',{id:'generated-img08-excluded',name:'Generated excluded source',kind:'upload',deviceId:'generated-img08-device',platform:'import',retention:'archive'});
 await command('on');await command('exclude',{excludedSourceIds:['generated-img08-excluded']});
 const excluded=await f.upload(f.images.find(image=>image.id==='small-text')!,{sourceId:'generated-img08-excluded'});
 assert.equal((await f.api('GET','/api/images/'+excluded)).products.some((value:any)=>value.kind==='understanding'),false);
 const archived=await f.upload(f.images.find(image=>image.id==='empty-ocr')!,{processingProfileId:'archive'});
 assert.equal((await f.api('GET','/api/files/'+archived)).job.stage,'archive');
 const perception=await f.api('GET','/api/perception');
 await f.api('PUT','/api/perception',{revision:perception.revision,settings:{...f.node.perception.settings(),understandingEnabled:false,allowQueryImages:false}});
 const disabled=await f.upload(f.images.find(image=>image.id==='region-crop')!),detail=await f.api('GET','/api/images/'+disabled);
 assert.ok(detail.products.some((value:any)=>value.kind==='ocr'));assert.equal(detail.products.some((value:any)=>value.kind==='understanding'),false);
 const requests=await f.workerRequests();for(const id of [excluded,archived,disabled])assert.equal(requests.some(value=>value.captureId===id),false);
 for(const id of [first,excluded,archived,disabled])assert.equal((await f.api('GET','/api/captures/'+id)).id,id);
 assert.equal(f.runs.length,0);
});

test('IMG08 matrix 5: direct dialogue image and regional follow-up use fresh actual Ask pixels and the same citation',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t),image=f.images.find(image=>image.id==='large')!;await f.prepare();await f.enable(true);const id=await f.upload(image);
 f.select(imagePlan(image,'generated-img08-ask','answer'));
 const first=await f.api('POST','/api/query',{question:'Inspect the directly attached generated raster.',attachmentIds:[id]});assert.equal(first.citations[0].id,id);assert.equal(first.imageReadReceipts.length,1);
 const region={x:64,y:80,width:32,height:24};f.select(imagePlan(image,'generated-img08-ask','answer',region));
 const next=await f.api('POST','/api/query',{question:'Inspect the requested region of the same generated reference.',conversationId:first.conversationId});
 assert.equal(next.citations[0].id,id);assert.equal(next.imageReadReceipts.length,1);assert.deepEqual(next.imageReadReceipts[0].imageView.region,region);
 assert.equal(f.runs.filter(run=>run.model==='generated-img08-ask').length,2);assert.equal(f.node.modelSettings.select('memory').settings.model,'generated-img08-memory');
});

test('IMG08 matrix 6: restart preserves the original and current products without a historical VLM rescan',{timeout:120000},async t=>{
 const f=await generatedImageCentral(t);f.select(()=>assert.fail('Restart cannot authorize another model'));await f.prepare();await f.enable(true);
 const image=f.images.find(image=>image.id==='small-text')!,id=await f.upload(image),before=await f.api('GET','/api/images/'+id),worker=await f.workerRequests();assert.equal(worker.length,1);
 await f.restart();await f.settle();const after=await f.api('GET','/api/images/'+id);
 assert.deepEqual(after.products,before.products);assert.equal((await f.api('GET','/api/captures/'+id)).id,id);assert.equal((await f.workerRequests()).length,worker.length);assert.equal(f.runs.length,0);
});
