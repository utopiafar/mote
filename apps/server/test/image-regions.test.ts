import {crc32,deflateSync} from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {imageOutput} from '../src/evidence-image.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function raster(){const width=11,height=17,data=Buffer.alloc(width*height*3);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*3;data[at]=x*20;data[at+1]=y*12;data[at+2]=(x+y)*8;}return sharp(data,{raw:{width,height,channels:3}}).png().toBuffer();}
const error=(code:string)=>(e:any)=>e.code===code;

test('metadata supplies verified original geometry without pixels; native crop has exact boundary pixels and distinct lineage',async()=>{
 const bytes=await raster(),id='generated',region={x:2,y:3,width:9,height:14},input={id,region,expectedImageSha256:hash(bytes)};
 const metadata=await imageOutput(bytes,'image/png',{id,view:'metadata'},()=>true);
 assert.equal(metadata.data,undefined);assert.equal(metadata.imageView!.output,undefined);assert.deepEqual(metadata.imageView!.original,{sha256:hash(bytes),width:11,height:17,mimeType:'image/png',orientation:1,pages:1});
 const result=await imageOutput(bytes,'image/png',input,()=>true),output=Buffer.from(result.data!,'base64');
 assert.deepEqual(result.imageView!.region,region);assert.equal(result.imageView!.output!.sha256,hash(output));assert.notEqual(result.imageView!.output!.sha256,hash(bytes));
 const expected=await sharp(bytes).extract({left:2,top:3,width:9,height:14}).raw().toBuffer();assert.deepEqual(await sharp(output).raw().toBuffer(),expected);
 assert.equal((await imageOutput(bytes,'image/png',input,()=>true)).imageView!.viewId,result.imageView!.viewId);
 const original=await imageOutput(bytes,'image/png',{id},()=>true);
 assert.equal(original.data,bytes.toString('base64'),'original bytes remain unchanged');
 assert.equal(original.imageView!.output!.sha256,hash(Buffer.from(original.data!,'base64')));
 assert.equal(original.imageView!.output!.sha256,original.imageView!.original.sha256);
});

test('regions reject invalid geometry, missing hashes, stale versions and corrupt or excessive originals',async()=>{
 const bytes=await raster(),base={id:'generated',expectedImageSha256:hash(bytes)},region={x:0,y:0,width:1,height:1};
 for(const bad of [{...region,x:-1},{...region,y:0.5},{...region,width:0},{...region,height:2049},{...region,x:1_000_001},{...region,extra:1}])await assert.rejects(imageOutput(bytes,'image/png',{...base,region:bad} as any,()=>true),error('invalid_image_region'));
 await assert.rejects(imageOutput(bytes,'image/png',{id:base.id,region},()=>true),error('invalid_image_region'));
 await assert.rejects(imageOutput(bytes,'image/png',{...base,view:'metadata',region},()=>true),error('invalid_image_region'));
 await assert.rejects(imageOutput(bytes,'image/png',{...base,region:{...region,x:11}},()=>true),error('invalid_image_region'));
 await assert.rejects(imageOutput(bytes,'image/png',{...base,region,expectedImageSha256:'0'.repeat(64)},()=>true),error('image_version_changed'));
 await assert.rejects(imageOutput(Buffer.from('not an image'),'image/png',{id:base.id},()=>true),/not a supported image/);
 await assert.rejects(imageOutput(bytes,'image/jpeg',{id:base.id},()=>true),/does not match/);
 await assert.rejects(imageOutput(Buffer.alloc(8*1024*1024+1),'image/png',{id:base.id},()=>true),/size limit/);
 const large=await sharp({create:{width:6400,height:6400,channels:3,background:'white'}}).png().toBuffer();
 await assert.rejects(imageOutput(large,'image/png',{id:base.id,view:'metadata'},()=>true),/not a supported image|dimensions unsupported/);
});

test('region coordinates follow encoded raster with EXIF orientation rather than rotated previews',async()=>{
 const bytes=await sharp(await raster()).withMetadata({orientation:6}).jpeg({quality:100}).toBuffer(),region={x:1,y:2,width:7,height:9};
 const result=await imageOutput(bytes,'image/jpeg',{id:'generated-exif',region,expectedImageSha256:hash(bytes)},()=>true),output=Buffer.from(result.data!,'base64');
 assert.equal(result.imageView!.original.orientation,6);assert.equal(result.imageView!.original.width,11);assert.equal(result.imageView!.original.height,17);
 assert.deepEqual(await sharp(output).raw().toBuffer(),await sharp(bytes).extract({left:1,top:2,width:7,height:9}).toColourspace('srgb').raw().toBuffer());
 const metadata=await sharp(output).metadata();assert.equal(metadata.orientation,undefined);assert.equal(metadata.width,7);assert.equal(metadata.height,9);
});

test('multi-frame regions explicitly fail while original bytes and metadata remain available',async()=>{
 const frames=Buffer.alloc(4*8*3,145);frames.fill(40,4*4*3);
 const bytes=await sharp(frames,{raw:{width:4,height:8,channels:3,pageHeight:4}}).webp({loop:0,delay:[100,100]}).toBuffer();
 const meta=await imageOutput(bytes,'image/webp',{id:'animation',view:'metadata'},()=>true);assert.equal(meta.imageView!.original.pages,2);
 await assert.rejects(imageOutput(bytes,'image/webp',{id:'animation',region:{x:0,y:0,width:2,height:2},expectedImageSha256:hash(bytes)},()=>true),error('image_region_multiframe'));
 assert.equal((await imageOutput(bytes,'image/webp',{id:'animation'},()=>true)).data,bytes.toString('base64'));
});

test('every path checks permission before decoding and after asynchronous metadata/crop work',async()=>{
 const bytes=await raster(),input={id:'generated',region:{x:0,y:0,width:2,height:2},expectedImageSha256:hash(bytes)};
 let calls=0;await assert.rejects(imageOutput(Buffer.from('private-not-decoded'),'image/png',input,()=>false),error('image_unavailable'));
 await assert.rejects(imageOutput(bytes,'image/png',{id:input.id,view:'metadata'},()=>++calls<2),error('image_unavailable'));assert.equal(calls,2);
 calls=0;await assert.rejects(imageOutput(bytes,'image/png',input,()=>++calls<3),error('image_unavailable'));assert.equal(calls,3);
});

test('native crop output is bounded independently from its compact JPEG original',async()=>{
 const data=Buffer.alloc(2048*2048*3);let state=1;for(let i=0;i<data.length;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;data[i]=state>>>24;}
 const bytes=await sharp(data,{raw:{width:2048,height:2048,channels:3}}).jpeg({quality:90}).toBuffer();assert.ok(bytes.length<8*1024*1024);
 await assert.rejects(imageOutput(bytes,'image/jpeg',{id:'generated-noise',expectedImageSha256:hash(bytes),region:{x:0,y:0,width:2048,height:2048}},()=>true),error('image_output_too_large'));
});

test('APNG animation is detected from bounded structure when libvips reports no pages',async()=>{
 const chunk=(name:string,data:Buffer)=>{const header=Buffer.alloc(8);header.writeUInt32BE(data.length);header.write(name,4,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name),data])));return Buffer.concat([header,data,crc]);};
 const size=Buffer.alloc(13);size.writeUInt32BE(1);size.writeUInt32BE(1,4);size[8]=8;size[9]=6;
 const animation=Buffer.alloc(8);animation.writeUInt32BE(2);
 const frame=(sequence:number)=>{const data=Buffer.alloc(26);data.writeUInt32BE(sequence);data.writeUInt32BE(1,4);data.writeUInt32BE(1,8);data.writeUInt16BE(1,20);data.writeUInt16BE(10,22);return data;};
 const sequence=Buffer.alloc(4);sequence.writeUInt32BE(2);
 const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',size),chunk('acTL',animation),chunk('fcTL',frame(0)),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('fcTL',frame(1)),chunk('fdAT',Buffer.concat([sequence,deflateSync(Buffer.from([0,0,0,255,255]))])),chunk('IEND',Buffer.alloc(0))]);
 const raw=await sharp(bytes).metadata();assert.equal(raw.pages,undefined,'fixture exercises libvips missing APNG page metadata');
 const metadata=await imageOutput(bytes,'image/png',{id:'generated-apng',view:'metadata'},()=>true);assert.equal(metadata.imageView!.original.pages,2);assert.equal(metadata.data,undefined);
 await assert.rejects(imageOutput(bytes,'image/png',{id:'generated-apng',expectedImageSha256:hash(bytes),region:{x:0,y:0,width:1,height:1}},()=>true),error('image_region_multiframe'));
 assert.equal((await imageOutput(bytes,'image/png',{id:'generated-apng'},()=>true)).data,bytes.toString('base64'));
});
