/** Explicit IMG-08 generated B stage. Model replies are synthetic; Central,
 * installation, worker, admission, SDK transport and publication are real. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {sha256} from '../../../apps/server/src/store.js';
import {RANGE_SELECTION_PERSONAL_RECIPE,SINGLE_PASS_PERSONAL_RECIPE} from '../../../apps/server/src/memory-range-selection-policy.js';
import type {MemoryWorkMember} from '../../../apps/server/src/memory-work-contract.js';
import {generatedImageCentral,modelText,pixels,toolResult,type Image,type ModelRequest,type Reply} from './local-image-central-generated.js';

type Central=Awaited<ReturnType<typeof generatedImageCentral>>;
type Envelope={taskId:string;request:string;untrustedTaskContext?:{memoryWork?:{catalog?:{key:string}[];members?:MemoryWorkMember[]};untrustedMemoryDraft?:{memories?:unknown[]}}};
function envelope(body:ModelRequest):Envelope{
 for(const message of body.messages)if(message.role==='user'){
  const value=modelText(message.content);
  try{const parsed=JSON.parse(value);if(typeof parsed.taskId==='string'&&typeof parsed.request==='string')return parsed;}catch{/* The separate image-handle user turn is not the Host envelope. */}
 }
 assert.fail('The actual provider request must contain the Host task envelope');
}
function gate(){let entered=false,release!:()=>void;return {released:new Promise<void>(resolve=>{release=resolve;}),enter:()=>{entered=true;},isEntered:()=>entered,release:()=>release()};}
async function eventually<T>(t:TestContext,read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{
 for(;;){t.signal.throwIfAborted();const value=await read();if(done(value))return value;await delay(10,undefined,{signal:t.signal});}
}
const terminal=(job:any)=>['completed','failed','waiting_for_model','waiting_for_input','cancelled'].includes(job.status);
async function reviewWaiting(t:TestContext,f:Central,id:string,held:ReturnType<typeof gate>){
 await eventually(t,()=>f.api('GET','/api/memory-jobs/'+id),job=>{if(held.isEntered())return true;assert.equal(terminal(job),false,'The real review did not reach its controlled boundary: '+JSON.stringify(job));return false;});
}

function modelPlan(image:Image,options:{wrongProof?:boolean;reviewGate?:ReturnType<typeof gate>}={}){
 const exchanges:{phase:'plan'|'extract'|'review';pixels:number;originalSha256?:string;viewId?:string}[]=[];
 return {exchanges,async reply(body:ModelRequest):Promise<Reply>{
  assert.equal(body.model,'generated-img08-memory','the plugin must not replace the owner-selected Memory model');
  const task=envelope(body),work=task.untrustedTaskContext?.memoryWork;
  assert.ok(work,'Memory planning and extraction use their real Host work context');
  const toolMessages=body.messages.filter(message=>message.role==='tool');
  if(work.catalog){
   exchanges.push({phase:'plan',pixels:pixels(body).length});
   assert.equal(pixels(body).length,0,'the planning catalog is not an image disclosure');
   if(!toolMessages.length){
    assert.equal(work.catalog.length,1,'this bounded fixture selects one generated original');
    assert.ok(body.tools?.some(tool=>tool.function.name==='delegation_submit'));
    return {tool:'delegation_submit',args:{units:[{id:'generated-img08-original',capabilityId:'memory.package',title:'Generated raster evidence',goal:'Inspect the generated original and select a scoped observation',input:{members:[work.catalog[0].key],instruction:'Read the generated original pixels and preserve their exact image evidence and uncertain attribution.'}}]}};
   }
   return {json:{answer:'The generated original work package was submitted.',citationIds:[]}};
  }
  const members=work.members;assert.ok(members?.length);
  const targets=members.filter(member=>member.imageTarget);assert.equal(targets.length,1);
  const member=targets[0],phase=task.untrustedTaskContext?.untrustedMemoryDraft?'review':'extract';
  assert.equal(member.imageTarget!.originalSha256,sha256(image.bytes));
  if(!toolMessages.length){
   assert.equal(pixels(body).length,0,'each independent model session starts without inherited pixels');
   exchanges.push({phase,pixels:0});return {tool:'read_image',args:{id:member.id,view:'metadata'}};
  }
  const view=toolResult(body).imageView;assert.ok(view);
  assert.equal(view.original.sha256,sha256(image.bytes));
  if(toolMessages.length===1){
   assert.equal(pixels(body).length,0,'metadata alone does not inspect pixels');
   exchanges.push({phase,pixels:0,originalSha256:view.original.sha256,viewId:view.viewId});
   return {tool:'read_image',args:{id:member.id,expectedImageSha256:view.original.sha256}};
  }
  const delivered=pixels(body);assert.equal(delivered.length,1);
  assert.equal(delivered[0].length,image.bytes.length);assert.equal(sha256(delivered[0]),sha256(image.bytes));
  const rgb=await sharp(delivered[0]).removeAlpha().toColourspace('srgb').raw().toBuffer();
  assert.equal(rgb.length,3145728);assert.equal(sha256(rgb),sha256(await sharp(image.bytes).removeAlpha().toColourspace('srgb').raw().toBuffer()));
  exchanges.push({phase,pixels:1,originalSha256:view.original.sha256,viewId:view.viewId});
  if(phase==='review'&&options.reviewGate){options.reviewGate.enter();await options.reviewGate.released;}
  const memories=[{title:'Generated raster reference',statement:`The retained reference contains a synthetic coloured raster. [${member.id}]`,uncertainty:'The creator, event date and significance to the owner are unknown.',admission:{layer:'observation',reason:'An observed property of the exact generated original',scope:'This generated reference only',attribution:'observed'},evidenceIds:[member.id],evidence:[{id:member.id,image:{originalSha256:view.original.sha256,viewId:options.wrongProof?'f'.repeat(64):view.viewId}}]}];
  return {json:{answer:JSON.stringify({memories,coverage:members.map(value=>({key:value.key,state:value.key===member.key?'checked':'no_candidates',candidateIndexes:value.key===member.key?[0]:[]}))}),citationIds:[member.id]}};
 }};
}

async function prepared(t:TestContext,options:Parameters<typeof modelPlan>[1]={}){
 const f=await generatedImageCentral(t),image=f.images.find(image=>image.id==='large')!,model=modelPlan(image,options);
 f.select(body=>model.reply(body));
 await f.prepare();await f.enable(true);assert.equal((await f.api('GET','/api/local-image-processing')).state,'ready');
 const captureId=await f.upload(image,{externalId:'generated-memory-reference.png'}),detail=await f.api('GET','/api/images/'+captureId);
 assert.equal(detail.products.find((product:any)=>product.kind==='understanding')?.text,image.interpretation.text);
 const worker=await f.workerRequests();assert.equal(worker.length,1);assert.equal(worker[0].originalSha256,sha256(image.bytes));assert.equal(worker[0].pixelBytes,3145728);
 t.diagnostic(JSON.stringify({stage:'generated-img08-B-worker',nodePid:process.pid,workerPid:await f.pid(),modelChildPid:worker[0].pid,originalBytes:image.bytes.length,pixelBytes:worker[0].pixelBytes}));
 return {...f,get node(){return f.node;},image,model,captureId};
}
async function start(f:Central,recipe:{id:string;version:string}){
 const installed=await f.api('GET','/api/memory-recipes');
 const selected=installed.items.find((value:any)=>value.id===recipe.id&&value.version===recipe.version);
 assert.equal(selected?.available,true,'use the currently installed immutable recipe');
 const listing=await f.api('GET','/api/materials?sourceId=generated-img08');assert.equal(listing.items.length,1);
 const material=await f.api('GET','/api/materials/'+listing.items[0].id);
 assert.equal(material.memorySource.status,'ready');assert.ok(material.memorySource.evidenceIds.length);
 const job=await f.api('POST','/api/memory-jobs',{evidenceIds:material.memorySource.evidenceIds,recipes:[recipe]});
 return {job,selected,material};
}
async function completed(t:TestContext,f:Central,id:string){return eventually(t,()=>f.api('GET','/api/memory-jobs/'+id),terminal);}

for(const [label,recipe,review] of [
 ['independent review',RANGE_SELECTION_PERSONAL_RECIPE,true],
 ['selected single-pass recipe',SINGLE_PASS_PERSONAL_RECIPE,false],
] as const)test(`generated IMG-08 B publishes through owner admission and actual SDK pixels: ${label}`,{timeout:120000},async t=>{
 const f=await prepared(t),models=await f.api('GET','/api/model-settings'),{job,selected}=await start(f,recipe);
 assert.equal(selected.binding.review===null,!review,'the selected recipe decides whether another semantic review runs');
 const done=await completed(t,f,job.id);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);
 const saved=await f.api('GET','/api/memories/'+done.memoryIds[0]);assert.equal(saved.status,'published');
 assert.equal(saved.evidence[0].image.original.sha256,sha256(f.image.bytes));
 assert.ok((await f.api('GET',`/api/memories/${saved.id}/evidence`)).items.length);
 const extracts=f.runs.filter(run=>run.phase==='extract'),reviews=f.runs.filter(run=>run.phase==='review');
 assert.equal(extracts.length,1);assert.equal(reviews.length,review?1:0);
 for(const run of [...extracts,...reviews]){assert.equal(run.model,'generated-img08-memory');assert.equal(run.images.length,1);assert.equal(run.images[0].imageView.original.sha256,sha256(f.image.bytes));}
 if(review){assert.notEqual(extracts[0].runId,reviews[0].runId);assert.ok(f.model.exchanges.some(exchange=>exchange.phase==='review'&&exchange.pixels===1));}
 else assert.equal(f.model.exchanges.some(exchange=>exchange.phase==='review'),false,'no extra semantic reviewer is forced');
 assert.deepEqual(await f.api('GET','/api/model-settings'),models,'Memory work cannot change any selected downstream model');
 t.diagnostic(JSON.stringify({stage:'generated-img08-B',recipe,extraReview:review,memoryId:saved.id,evidence:saved.evidence,runs:f.runs.map(({model,phase,runId,images})=>({model,phase,runId,images})),exchanges:f.model.exchanges}));
});

test('generated IMG-08 B rejects an undelivered image view proof despite the model having read the original',{timeout:120000},async t=>{
 const f=await prepared(t,{wrongProof:true}),{job}=await start(f,SINGLE_PASS_PERSONAL_RECIPE),done=await completed(t,f,job.id);
 assert.notEqual(done.status,'completed',JSON.stringify(done));assert.deepEqual(done.memoryIds,[]);
 assert.equal((await f.api('GET','/api/memories')).items.length,0);
 assert.ok(f.model.exchanges.some(exchange=>exchange.phase==='extract'&&exchange.pixels===1),'the refusal is exact proof validation, not missing pixels');
});

test('generated IMG-08 B cancellation rejects a late independent reviewer response without publication',{timeout:120000},async t=>{
 const held=gate();t.after(()=>held.release());const f=await prepared(t,{reviewGate:held}),{job}=await start(f,RANGE_SELECTION_PERSONAL_RECIPE);
 await reviewWaiting(t,f,job.id,held);
 await f.api('POST',`/api/memory-jobs/${job.id}/cancel`);held.release();
 const done=await completed(t,f,job.id);assert.equal(done.status,'cancelled');assert.deepEqual(done.memoryIds,[]);
 await eventually(t,async()=>f.runs.every(run=>run.settled),Boolean);
 assert.equal((await f.api('GET','/api/memories')).items.length,0);
 assert.ok(f.model.exchanges.some(exchange=>exchange.phase==='review'&&exchange.pixels===1));
});

for(const mutation of ['delete','replace','source'] as const)test(`IMG08 matrix 6: ${mutation} rejects a late image Memory review under the original pinned scope`,{timeout:120000},async t=>{
 const held=gate();t.after(()=>held.release());const f=await prepared(t,{reviewGate:held}),{job}=await start(f,RANGE_SELECTION_PERSONAL_RECIPE);
 await reviewWaiting(t,f,job.id,held);
 if(mutation==='delete')await f.api('DELETE','/api/files/'+f.captureId);
 else if(mutation==='source')await f.api('PATCH','/api/sources/generated-img08',{ownerRelation:'third_party'});
 else{
  await f.upload(f.images.find(image=>image.id==='region-crop')!,{externalId:'generated-memory-reference.png',revision:'2',previousRevision:'1',settle:false});
  for(let i=0;i<30;i++)if(await f.node.materialOrganizer.tick(100)===0)break;
 }
 held.release();const done=await completed(t,f,job.id);assert.notEqual(done.status,'completed',JSON.stringify(done));assert.deepEqual(done.memoryIds,[]);
 await eventually(t,async()=>f.runs.every(run=>run.settled),Boolean);assert.equal((await f.api('GET','/api/memories')).items.length,0);
});

test('generated IMG-08 B ordinary original release preserves published Memory while explicit file forgetting withdraws it',{timeout:120000},async t=>{
 const f=await prepared(t),{job}=await start(f,SINGLE_PASS_PERSONAL_RECIPE),done=await completed(t,f,job.id);
 assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.memoryIds.length,1);const id=done.memoryIds[0];
 await f.api('DELETE','/api/files/'+f.captureId);assert.equal((await f.api('GET','/api/memories/'+id)).status,'published');
 assert.equal((await f.raw('GET',`/api/files/${f.captureId}/content`)).status,404,'ordinary release does not preserve raw pixels through Memory');
 // This existing file-owner forget operation is the explicit owner lifecycle
 // command, distinct from deleteArchive/release; it is not a model action.
 f.node.files.forget(f.captureId);assert.equal((await f.raw('GET','/api/memories/'+id)).status,404);
 await f.restart();assert.equal((await f.raw('GET','/api/memories/'+id)).status,404,'revocation remains after restart');
});
