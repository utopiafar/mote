/** Generated geometry only. Does not import a runner, frozen fixture, question, rubric or product bridge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {ComposedImageDisclosure} from './composed-image-disclosure.js';
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
type Json=Record<string,any>;
async function fixture(format:'png'|'jpeg'|'webp'='png'){
 const bytes=await sharp({create:{width:12,height:12,channels:3,background:'#356791'}}).toFormat(format).toBuffer(),mimeType='image/'+format,original={sha256:hash(bytes),width:12,height:12,mimeType,orientation:1,pages:1};
 async function wire(args:Json,kind:'metadata'|'payload'|'repeat',remaining:number,first?:{args:Json;result:Json}){
  const region=args.region??null,transform=kind==='metadata'?'metadata@1':region?'crop-encoded-raster-png@1':'original-bytes@1';
  const view:Json={original,coordinateSpace:'encoded-raster-pixels-v1',region,transform,viewId:hash(JSON.stringify([original.sha256,'encoded-raster-pixels-v1',region,transform])),id:args.id,...(args.attachmentId?{attachmentId:args.attachmentId}:{}),delivery:kind==='metadata'?'metadata':kind==='repeat'?'already_disclosed':'pending'};
  const payload=region?await sharp(bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height}).toColourspace('srgb').png().toBuffer():bytes;
  if(kind!=='metadata')view.output={sha256:hash(payload),width:region?.width??12,height:region?.height??12,mimeType:region?'image/png':mimeType,sizeBytes:payload.length};
  const result:Json={source:'untrusted_personal_context',...args,imageView:view,imageBudget:{remainingPayloads:remaining,maxRegionSide:2048,maxOutputBytes:8*1024*1024},hostBudget:{remainingCalls:20,remainingCharactersBeforeResult:20000,unit:'utf16_characters'}};
  if(kind==='payload'){result.image={mimeType:region?'image/png':mimeType,data:payload.toString('base64')};result.imageDelivery='a'.repeat(48);}
  if(kind==='repeat'){assert.ok(first);result.imageDisclosure={status:'already_disclosed',sha256:hash(payload),mimeType:region?'image/png':mimeType,firstSelection:first.args,firstImageView:{...first.result.imageView,delivery:'prepared'}};}
  return {args,result};
 }
 return {bytes,hash:original.sha256,wire,audit:()=>new ComposedImageDisclosure('bounded-views',bytes,12,12)};
}
function adapter(rows:Array<{args:Json;result:Json}>){
 const events=rows.map(({result})=>{const value=structuredClone(result);delete value.imageDelivery;if(value.image){value.image={mimeType:value.image.mimeType,encodedCharacters:value.image.data.length};if(value.imageView)value.imageView.delivery='prepared';}return {type:'tool.completed',tool:'read_image',status:'succeeded',payload:{result:value}};});
 return {events,trace:rows.map(({args},i)=>({tool:'read_image',arguments:args,count:1,...(events[i].payload.result.imageView?{imageView:events[i].payload.result.imageView}:{})}))};
}

test('bounded views count metadata, raw/formal attachment aliases and child originals without attachmentId',async()=>{
 const f=await fixture(),audit=f.audit(),region={x:0,y:0,width:2,height:2};
 const metadata=await f.wire({id:'formal',attachmentId:'attachment',view:'metadata'},'metadata',4);
 const first=await f.wire({id:'formal',attachmentId:'attachment',expectedImageSha256:f.hash,region},'payload',3);
 const repeat=await f.wire({id:'raw',attachmentId:'attachment',expectedImageSha256:f.hash,region:{...region,x:4}},'repeat',3,first);
 const child=await f.wire({id:'child'},'payload',2),last=await f.wire({id:'formal',attachmentId:'attachment'},'repeat',2,child);
 const rows=[metadata,first,repeat,child,last];for(const row of rows)await audit.observeSuccessfulRead(row.args,row.result);
 const final=adapter(rows),report=audit.verifyModelDelivery(final.trace,final.events);
 assert.equal(report.imagePayloads,2);assert.equal(report.metadataReads,1);assert.equal(report.repeatedDisclosureMetadata,2);assert.equal(report.successfulReads,5);assert.equal(report.adapterPreparationVerified,true);
 assert.equal(report.reads[2].imageView!.id,'raw');assert.equal(report.reads[2].imageView!.region.x,4);assert.ok(!JSON.stringify(report).includes(first.result.image.data));
});

test('default one-original accepts legacy delivery/repeat without imageView and rejects metadata or region',async()=>{
 const f=await fixture(),audit=new ComposedImageDisclosure('one-original',f.bytes,12,12),first=await f.wire({id:'child'},'payload',3),repeat=await f.wire({id:'raw',attachmentId:'attachment'},'repeat',3,first);
 for(const row of [first,repeat]){delete row.result.imageView;delete row.result.imageBudget;delete row.result.hostBudget;await audit.observeSuccessfulRead(row.args,row.result);}
 const final=adapter([first,repeat]);assert.equal(audit.verifyModelDelivery(final.trace,final.events).imagePayloads,1);
 for(const args of [{id:'raw',view:'metadata'},{id:'raw',expectedImageSha256:f.hash,region:{x:0,y:0,width:1,height:1}}]){const row=await f.wire(args,args.view?'metadata':'payload',args.view?4:3);await assert.rejects(new ComposedImageDisclosure('one-original',f.bytes,12,12).observeSuccessfulRead(args,row.result),/Legacy mode/);}
});

test('metadata-only success and missing adapter payload cannot masquerade as image delivery',async()=>{
 const f=await fixture(),audit=f.audit(),meta=await f.wire({id:'child',view:'metadata'},'metadata',4);await audit.observeSuccessfulRead(meta.args,meta.result);const empty=adapter([meta]);assert.throws(()=>audit.verifyModelDelivery(empty.trace,empty.events),/Metadata alone/);
 const first=await f.wire({id:'child'},'payload',3),other=f.audit();await other.observeSuccessfulRead(first.args,first.result);const final=adapter([first]);delete final.events[0].payload.result.image;assert.throws(()=>other.verifyModelDelivery(final.trace,final.events));
});

test('every successful read is reconciled, including unexpected child aliases or missing imageView',async()=>{
 const f=await fixture(),audit=f.audit(),first=await f.wire({id:'child'},'payload',3);await audit.observeSuccessfulRead(first.args,first.result);const final=adapter([first]);
 assert.throws(()=>audit.verifyModelDelivery([...final.trace,{tool:'read_image',arguments:{id:'other-child'},count:1}],final.events),/Unaccounted/);
 const missing=structuredClone(first);delete missing.result.imageView;await assert.rejects(f.audit().observeSuccessfulRead(missing.args,missing.result),/requires imageView/);
 delete final.trace[0].imageView;assert.throws(()=>audit.verifyModelDelivery(final.trace,final.events));
});

test('unknown originals, transforms, geometry, output hashes and pixel substitutions fail closed',async()=>{
 const f=await fixture(),args={id:'child',expectedImageSha256:f.hash,region:{x:1,y:2,width:3,height:4}},valid=await f.wire(args,'payload',3);
 const mutations=[(r:Json)=>r.imageView.original.sha256='0'.repeat(64),(r:Json)=>r.imageView.transform='resize@1',(r:Json)=>r.imageView.output.width=4,(r:Json)=>r.imageView.output.sha256='0'.repeat(64),(r:Json)=>r.imageView.id='unrelated',(r:Json)=>r.image.data=f.bytes.toString('base64')];
 for(const mutate of mutations){const result=structuredClone(valid.result);mutate(result);const audit=f.audit();await assert.rejects(audit.observeSuccessfulRead(args,result));assert.ok(audit.snapshot().accountingFailure);assert.throws(()=>audit.verifyModelDelivery([],[]));}
 await assert.rejects(f.audit().observeSuccessfulRead({...args,expectedImageSha256:'0'.repeat(64)},valid.result),/unknown original/);
 await assert.rejects(f.audit().observeSuccessfulRead({...args,region:{...args.region,x:11}},valid.result),/exceeds original/);
});

test('four distinct payloads are allowed; a fifth and a duplicate actual payload are refused',async()=>{
 const f=await fixture(),audit=f.audit(),rows=[];
 for(let width=1;width<=4;width++){const row=await f.wire({id:'child',expectedImageSha256:f.hash,region:{x:0,y:0,width,height:2}},'payload',4-width);rows.push(row);await audit.observeSuccessfulRead(row.args,row.result);}
 const final=adapter(rows);assert.equal(audit.verifyModelDelivery(final.trace,final.events).imagePayloads,4);
 const fifth=await f.wire({id:'child',expectedImageSha256:f.hash,region:{x:0,y:0,width:5,height:2}},'payload',0);await assert.rejects(audit.observeSuccessfulRead(fifth.args,fifth.result),/quota/);
 const duplicate=f.audit();await duplicate.observeSuccessfulRead(rows[0].args,rows[0].result);await assert.rejects(duplicate.observeSuccessfulRead(rows[0].args,rows[0].result),/appended again/);
});

test('repeat needs an observed first payload and retains its first source and current geometry',async()=>{
 const f=await fixture(),first=await f.wire({id:'child'},'payload',3),repeat=await f.wire({id:'formal',attachmentId:'attachment'},'repeat',3,first);
 await assert.rejects(f.audit().observeSuccessfulRead(repeat.args,repeat.result),/never received/);
 for(const mutate of [(r:Json)=>r.imageDisclosure.firstSelection.id='other',(r:Json)=>r.imageDisclosure.firstImageView.id='other']){const audit=f.audit();await audit.observeSuccessfulRead(first.args,first.result);const result=structuredClone(repeat.result);mutate(result);await assert.rejects(audit.observeSuccessfulRead(repeat.args,result));}
});

test('metadata pixels, absent budgets and incorrect remaining quota are rejected',async()=>{
 const f=await fixture(),metadata=await f.wire({id:'child',view:'metadata'},'metadata',4);metadata.result.image={mimeType:'image/png',data:f.bytes.toString('base64')};await assert.rejects(f.audit().observeSuccessfulRead(metadata.args,metadata.result));
 const first=await f.wire({id:'child'},'payload',3);for(const mutate of [(r:Json)=>delete r.hostBudget,(r:Json)=>r.imageBudget.remainingPayloads=4]){const result=structuredClone(first.result);mutate(result);await assert.rejects(f.audit().observeSuccessfulRead(first.args,result));}
});

test('adapter must retain both quotas and the first-view lineage of a successful repeat',async()=>{
 const f=await fixture(),audit=f.audit(),first=await f.wire({id:'child'},'payload',3),repeat=await f.wire({id:'formal',attachmentId:'attachment'},'repeat',3,first);
 for(const row of [first,repeat])await audit.observeSuccessfulRead(row.args,row.result);
 for(const mutate of [(events:Json[])=>delete events[0].payload.result.imageBudget,(events:Json[])=>delete events[0].payload.result.hostBudget,(events:Json[])=>delete events[1].payload.result.imageDisclosure.firstImageView,(events:Json[])=>events[1].payload.result.imageDisclosure.firstSelection.id='unrelated']){
  const final=adapter([first,repeat]);mutate(final.events);assert.throws(()=>audit.verifyModelDelivery(final.trace,final.events));
 }
});

for(const format of ['png','jpeg','webp'] as const)test(`${format}: unchanged originals and PNG regions retain MIME, bytes, aliases and adapter lineage`,async()=>{
 const f=await fixture(format),audit=f.audit();
 const metadata=await f.wire({id:'formal',attachmentId:'attachment',view:'metadata'},'metadata',4);
 const original=await f.wire({id:'child'},'payload',3);
 const repeated=await f.wire({id:'raw',attachmentId:'attachment'},'repeat',3,original);
 const crop=await f.wire({id:'formal',attachmentId:'attachment',expectedImageSha256:f.hash,region:{x:1,y:2,width:3,height:4}},'payload',2);
 for(const row of [metadata,original,repeated,crop])await audit.observeSuccessfulRead(row.args,row.result);
 assert.equal(crop.result.image.mimeType,'image/png');assert.equal(original.result.image.mimeType,'image/'+format);
 const final=adapter([metadata,original,repeated,crop]);assert.equal(audit.verifyModelDelivery(final.trace,final.events).imagePayloads,2);
 const legacy=new ComposedImageDisclosure('one-original',f.bytes,12,12),legacyRow=structuredClone(original);delete legacyRow.result.imageView;
 await legacy.observeSuccessfulRead(legacyRow.args,legacyRow.result);const old=adapter([legacyRow]);assert.equal(legacy.verifyModelDelivery(old.trace,old.events).imagePayloads,1);
 for(const mutate of [(r:Json)=>r.image.mimeType='image/gif',(r:Json)=>r.imageView.original.mimeType='image/gif',(r:Json)=>r.imageView.output.mimeType='image/gif']){
  const result=structuredClone(original.result);mutate(result);await assert.rejects(f.audit().observeSuccessfulRead(original.args,result));
 }
 const wrongAdapter=adapter([metadata,original,repeated,crop]);wrongAdapter.events[1].payload.result.image.mimeType='image/gif';assert.throws(()=>audit.verifyModelDelivery(wrongAdapter.trace,wrongAdapter.events));
 const wrongRepeat=adapter([metadata,original,repeated,crop]);wrongRepeat.events[2].payload.result.imageDisclosure.mimeType='image/gif';assert.throws(()=>audit.verifyModelDelivery(wrongRepeat.trace,wrongRepeat.events));
});
