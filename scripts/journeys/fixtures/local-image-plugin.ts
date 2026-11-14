/** Generated input/transport validation only. Reuse IMG-00's specimens and the
 * production reader/parser; this does not install a worker or assemble Central. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {IMAGE_MAX_BYTES,IMAGE_MAX_PIXELS,type ImageReadResult} from '@mote/shared';
import {imageOutput} from '../../../apps/server/src/evidence-image.js';
import {LOCAL_IMAGE_PROTOCOL,localImageRequestSchema,parseLocalImageResponse} from '../../../apps/server/src/local-image-contract.js';
import {generatedLocalImages,generatedLocalImageResponse,type LocalImageFixture} from '../../../apps/server/test/fixtures/local-image.js';

const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const expectedIds=['photo','small-text','long-image','region-crop','empty-ocr','malicious-text'];

export async function generatedFixtureExamples(){
 const fixtures=await generatedLocalImages();
 assert.deepEqual(fixtures.map(image=>image.id),expectedIds);
 return Promise.all(fixtures.map(async image=>{
  assert.ok(image.bytes.length>0&&image.bytes.length<=IMAGE_MAX_BYTES);
  assert.ok(image.width*image.height<=IMAGE_MAX_PIXELS);
  const geometry=await sharp(image.bytes).metadata();
  assert.equal(geometry.format,'png');assert.equal(geometry.width,image.width);assert.equal(geometry.height,image.height);
  const captureId=randomUUID(),originalSha256=sha256(image.bytes);
  const metadata=await imageOutput(image.bytes,image.mimeType,{id:captureId,view:'metadata'},()=>true);
  assert.equal(metadata.data,undefined,'metadata must not become delivered pixels');
  const original=await imageOutput(image.bytes,image.mimeType,{id:captureId,expectedImageSha256:originalSha256},()=>true);
  assert.equal(original.data,image.bytes.toString('base64'));
  const delivered=image.region?await imageOutput(image.bytes,image.mimeType,{id:captureId,expectedImageSha256:originalSha256,region:image.region},()=>true):original;
  assert.equal(delivered.imageView!.original.sha256,metadata.imageView!.original.sha256);
  if(image.region){
   const region=image.region;
   assert.deepEqual(delivered.imageView!.region,region);
   assert.deepEqual(await sharp(Buffer.from(delivered.data!,'base64')).raw().toBuffer(),await sharp(image.bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height}).toColourspace('srgb').raw().toBuffer());
  }
  const request=localImageRequestSchema.parse({version:LOCAL_IMAGE_PROTOCOL.version,operationId:'generated-img08:'+captureId,captureId,image:delivered,ocr:image.ocr,
   context:{capturedAt:'2026-10-01T00:00:00Z',sourceType:'file',sourceId:'generated-img08',sourceRevision:'1',document:{contentRole:'reference',timeBasis:'unknown'}}});
  // JSON round-trips here are actual producer bytes consumed by the current
  // parsers. Authored observations are protocol fixtures, not model inference.
  const requestBytes=JSON.stringify(request),responseBytes=JSON.stringify(generatedLocalImageResponse(localImageRequestSchema.parse(JSON.parse(requestBytes)),image));
  const response=parseLocalImageResponse(JSON.parse(responseBytes),request);
  assert.equal(response.status,'ok');
  if(response.status!=='ok')throw Error('Expected generated success');
  assert.equal(response.usage,undefined,'unknown usage is omitted');
  for(const region of response.result.regions)assert.ok(region.x+region.width<=image.width&&region.y+region.height<=image.height);
  return {image,originalSha256,metadata:metadata.imageView!,original,delivered,request:JSON.parse(requestBytes),response};
 }));
}

function view(image:LocalImageFixture,read:ImageReadResult){
 return {originalFile:image.id+'.png',imageView:read.imageView,payloadBytes:read.data?Buffer.from(read.data,'base64').length:0};
}

export async function writeGeneratedFixtures(directory:string){
 const examples=await generatedFixtureExamples();
 const manifest={evidenceKind:'generated-input-and-contract',personalDataUsed:false,modelInference:false,centralStarted:false,
  measurements:{coldLatencyMs:null,warmLatencyMs:null,memoryBytes:null},
  samples:examples.map(({image,originalSha256,original,delivered})=>({id:image.id,file:image.id+'.png',mimeType:image.mimeType,width:image.width,height:image.height,sizeBytes:image.bytes.length,sha256:originalSha256,
   ocrStatus:image.ocr.segments.length?'generated-text':'generated-success-empty',original:view(image,original),workerInput:view(image,delivered)})),
 };
 for(const {image,request,response} of examples){
  await writeFile(join(directory,image.id+'.png'),image.bytes,{flag:'wx',mode:0o600});
  await writeFile(join(directory,image.id+'.transport.json'),JSON.stringify({evidenceKind:'generated-transport-only',request,response},null,2)+'\n',{flag:'wx',mode:0o600});
 }
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 return manifest;
}
