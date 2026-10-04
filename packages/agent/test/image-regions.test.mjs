import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {startBridge} from '../dist/bridge.js';
import {generatedImageRead,digest} from './image-region-fixture.mjs';
const record={id:'6f7a917a-a0f6-56d1-bde0-86fa7f2938cc',capturedAt:'2026-09-27T00:00:00Z',appName:'Generated pixels',sourceType:'file',ocrText:'Generated geometric fixture'};
async function call(b,tool,args,ack=true){const res=await fetch(b.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+b.token},body:JSON.stringify(args)}),body=await res.json();if(ack&&body.imageDelivery)b.imageDelivery(body.imageDelivery,true);return {status:res.status,body};}
async function fixture(t){
 let bytes=await sharp({create:{width:40,height:20,channels:3,background:'#ab3490'}}).png().toBuffer(),allowed=true,reads=0,deleted=false;
 const alias={...record,id:'61d5c64d-bfca-5530-9ced-d1f904984252',sourceType:'message',provenance:{document:{attachments:[{id:'generated-image'}]}}};
 const rows=()=>deleted?[]:[record,alias],reader={search:async()=>rows(),timeline:async()=>({items:(rows()),nextCursor:null}),evidence:async({ids})=>rows().filter(r=>ids.includes(r.id)),activity:async()=>({}),devices:async()=>[],readImage:async args=>{reads++;if(!allowed)throw Error('Generated revocation');return generatedImageRead(bytes,args);}};
 const open=async()=>{const bridge=await startBridge(reader,{question:'Generated regions'},40);t.after(()=>bridge.close());await call(bridge,'timeline',{});await call(bridge,'evidence',{ids:[record.id,alias.id]});return bridge;};
 return {open,alias,get bytes(){return bytes;},set bytes(value){bytes=value;},set allowed(value){allowed=value;},set deleted(value){deleted=value;},get reads(){return reads;}};
}
test('metadata, regions, aliases and identical pixels retain current and first source geometry',async t=>{
 const f=await fixture(t),b=await f.open(),expectedImageSha256=digest(f.bytes),region={x:0,y:0,width:8,height:8};
 const meta=await call(b,'read_image',{id:record.id,view:'metadata'});assert.equal(meta.status,200);assert.equal(meta.body.image,undefined);assert.equal(meta.body.imageBudget.remainingPayloads,4);assert.equal(meta.body.imageView.original.sha256,expectedImageSha256);
 const first=await call(b,'read_image',{id:record.id,expectedImageSha256,region});assert.equal(first.status,200);assert.ok(first.body.image);assert.equal(first.body.imageBudget.remainingPayloads,3);
 const repeated=await call(b,'read_image',{id:f.alias.id,attachmentId:'generated-image',expectedImageSha256,region:{...region,x:8}});assert.equal(repeated.status,200);assert.equal(repeated.body.image,undefined);assert.equal(repeated.body.imageView.id,f.alias.id);assert.equal(repeated.body.imageView.region.x,8);assert.equal(repeated.body.imageDisclosure.firstImageView.id,record.id);assert.equal(repeated.body.imageDisclosure.firstImageView.region.x,0);assert.notEqual(repeated.body.imageView.viewId,repeated.body.imageDisclosure.firstImageView.viewId);
 const different=await call(b,'read_image',{id:record.id,expectedImageSha256,region:{...region,width:9}});assert.ok(different.body.image);assert.equal(different.body.imageBudget.remainingPayloads,2);
 assert.deepEqual(b.trace.filter(row=>row.tool==='read_image').map(row=>row.imageView.delivery),['metadata','prepared','already_disclosed','prepared']);assert.ok(!JSON.stringify(b.trace).includes(first.body.image.data));
 const fresh=await f.open();assert.ok((await call(fresh,'read_image',{id:record.id,expectedImageSha256,region})).body.image,'another query gets its first pixels');
});
test('region quota never skips current permission/version checks; metadata remains available',async t=>{
 const f=await fixture(t),b=await f.open(),expectedImageSha256=digest(f.bytes),input={id:record.id,expectedImageSha256,region:{x:0,y:0,width:5,height:5}};
 for(let width=5;width<9;width++)assert.ok((await call(b,'read_image',{...input,region:{...input.region,width}})).body.image);
 assert.equal((await call(b,'read_image',input)).body.imageDisclosure.status,'already_disclosed');
 f.allowed=false;const before=f.reads;assert.equal((await call(b,'read_image',input)).status,400);assert.equal(f.reads,before+1);f.allowed=true;
 assert.equal((await call(b,'read_image',{id:record.id,view:'metadata'})).body.imageBudget.remainingPayloads,0);
 const exceeded=await call(b,'read_image',{...input,region:{...input.region,width:10}});assert.equal(exceeded.body.toolError.code,'image_budget_exceeded');
 f.bytes=await sharp({create:{width:40,height:20,channels:3,background:'#dcdcdc'}}).png().toBuffer();assert.equal((await call(b,'read_image',input)).body.toolError.code,'image_version_changed');
 f.deleted=true;assert.equal((await call(b,'read_image',{id:record.id,view:'metadata'})).status,400);
});
test('region delivery failure lets a concurrent reader deliver its first image',async t=>{
 const f=await fixture(t),b=await f.open(),input={id:record.id,expectedImageSha256:digest(f.bytes),region:{x:1,y:1,width:3,height:4}};
 const first=await call(b,'read_image',input,false),pending=call(b,'read_image',input,false);while(f.reads<2)await new Promise(resolve=>setTimeout(resolve,1));
 b.imageDelivery(first.body.imageDelivery,false);const second=await pending;assert.ok(second.body.image);assert.ok(f.reads>=2,'the concurrent reader performs its own authorized read; it may finish after the failed reservation is already released');b.imageDelivery(second.body.imageDelivery,true);
 assert.deepEqual(b.trace.filter(row=>row.tool==='read_image').map(row=>row.imageView.delivery),['failed','prepared']);assert.equal((await call(b,'read_image',input)).body.imageDisclosure.status,'already_disclosed');
});
test('unsupported or mismatched region responses fail closed, never masquerading as full image success',async t=>{
 const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#abc'}}).png().toBuffer();let read=async()=>({mimeType:'image/png',data:bytes.toString('base64')});
 const b=await startBridge({search:async()=>[record],timeline:async()=>({items:([record]),nextCursor:null}),evidence:async()=>[record],activity:async()=>({}),devices:async()=>[],readImage:args=>read(args)},{question:'Generated bounds'},16);t.after(()=>b.close());await call(b,'timeline',{});await call(b,'evidence',{ids:[record.id]});
 const input={id:record.id,expectedImageSha256:digest(bytes),region:{x:0,y:0,width:3,height:3}};
 assert.equal((await call(b,'read_image',input)).body.toolError.code,'image_view_unsupported');
 read=async args=>{const result=await generatedImageRead(bytes,args);result.imageView.output.sha256='0'.repeat(64);return result;};assert.equal((await call(b,'read_image',input)).status,400);
 assert.equal((await call(b,'read_image',{...input,region:{...input.region,x:0.5}})).body.toolError.code,'invalid_image_region');
});
