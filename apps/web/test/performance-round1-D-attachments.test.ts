import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FILE_PART_BYTES} from '@mote/shared';
import {uploadChatImage,uploadNoteAttachment} from '../src/note-attachments.js';
import {uploadFilePart} from '../src/upload-part.js';
import type {Api,WebConnection} from '../src/api.js';

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const identity=(value:unknown)=>hash(JSON.stringify(value));
const connection:WebConnection={mode:'web',origin:'http://fixture.invalid',deploymentId:'generated-deployment',userId:'generated-owner',credentialId:'generated-credential',csrfToken:'generated-csrf',username:'generated',administrator:false};
const generated=(size:number)=>new File([Uint8Array.from({length:size},(_,i)=>(i*31+19)%251)],'generated.png',{type:'image/png',lastModified:1234});
function fixture(file:File){
 let manifest:any,commits=0,lost=false,badPart='',badReceipt='',badOwner=false,badResume=false,onPut:(()=>void)|undefined;
 const parts=new Map<number,Buffer>(),wire:{path:string;body:string}[]=[],requests:string[]=[];
 const receipt=()=>{
  const {sourceId,batchId,revision}=manifest,h=identity([sourceId,revision.item.externalId,revision.item.revision]),captureId=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  const original={ref:'original:'+identity([connection.userId,sourceId,captureId,revision.sha256,file.type,'archive']),sourceId,captureId,hash:revision.sha256,bytes:file.size,mime:file.type,retention:'archive'};
  if(badReceipt==='hash')original.hash='wrong';if(badReceipt==='bytes')original.bytes++;if(badReceipt==='original')original.ref='wrong';
  return {version:3,state:'received',deploymentId:connection.deploymentId,userId:badReceipt==='owner'?'other-owner':connection.userId,sourceId,batchId,captures:[{id:captureId,sourceId,externalId:revision.item.externalId,revision:revision.item.revision,duplicate:false,original}]};
 };
 const api={connection,request:async(path:string,init:RequestInit)=>{
  requests.push(path);assert.equal(init.signal?.aborted??false,false);
  if(path==='/api/ingress/devices'||path==='/api/ingress/sources')return {};
  if(path.endsWith('/uploads')){
   const incoming=JSON.parse(String(init.body));if(manifest)assert.deepEqual(incoming,manifest);manifest=incoming;
   assert.equal(manifest.revision.sizeBytes,file.size);
   return {id:'generated-upload',deploymentId:connection.deploymentId,userId:badOwner?'wrong':connection.userId,sourceId:manifest.sourceId,partBytes:FILE_PART_BYTES,parts:[...parts].map(([part,bytes])=>({part,checksum:badResume?'wrong':hash(bytes),bytes:bytes.length})),...(commits?{receipt:receipt()}:{})};
  }
  if(path.endsWith('/commit')){commits++;return receipt();}
  const part=Number(path.split('/').at(-1)),bytes=Buffer.from(await file.slice(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES).arrayBuffer());
  // This is the pre-change wire algorithm, computed independently of the callback.
  const expected=JSON.stringify({bytes:bytes.toString('base64'),checksum:hash(bytes)});
  assert.equal(String(init.body),expected,'exact original JSON/base64 wire bytes and key order');
  wire.push({path,body:String(init.body)});parts.set(part,bytes);onPut?.();
  if(lost){lost=false;throw Error('Generated lost ACK');}
  return {part:badPart==='part'?part+1:part,checksum:badPart==='checksum'?'wrong':hash(bytes),bytes:bytes.length+(badPart==='bytes'?1:0)};
 }} as Api;
 return {api,wire,parts,requests,get commits(){return commits;},get manifest(){return manifest;},loseAck:()=>lost=true,corruptPart:(field:string)=>badPart=field,corruptReceipt:(field:string)=>badReceipt=field,corruptOwner:()=>badOwner=true,corruptResume:()=>badResume=true,onPut:(callback:()=>void)=>onPut=callback};
}

for(const size of [1,FILE_PART_BYTES,FILE_PART_BYTES+17])test(`Web attachment ${size} bytes keeps exact wire and hashes each slice only once`,async t=>{
 const file=generated(size),bytes=Buffer.from(await file.arrayBuffer()),f=fixture(file),digests:Buffer[]=[],digest=crypto.subtle.digest;
 t.mock.method(crypto.subtle,'digest',async function(this:SubtleCrypto,algorithm:AlgorithmIdentifier,data:BufferSource){digests.push(Buffer.from(data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength)));return digest.call(this,algorithm,data);});
 const id=await uploadChatImage(f.api,file,'generated-device');assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(f.manifest.revision.sha256,hash(bytes));assert.equal(f.commits,1);assert.equal(f.wire.length,Math.ceil(size/FILE_PART_BYTES));
 // For a one-part file the full-file and sole-slice bytes coincide: both SHAs remain.
 assert.equal(digests.filter(value=>value.equals(bytes)).length,size<=FILE_PART_BYTES?2:1,'full-file SHA retained, duplicate sender SHA removed');
 if(size>FILE_PART_BYTES)for(let part=0;part<2;part++)assert.equal(digests.filter(value=>value.equals(bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES))).length,1,'one SHA for each slice');
 t.diagnostic(JSON.stringify({bytes:size,parts:f.wire.length,sha256Calls:digests.length,wireEqual:true}));
});

test('Web lost ACK resumes verified parts and reuses only immutable owner durable receipts',async()=>{
 const file=generated(FILE_PART_BYTES+17),f=fixture(file);f.loseAck();await assert.rejects(uploadNoteAttachment(f.api,file,'generated-device'),/lost ACK/);assert.equal(f.commits,0);
 const id=await uploadNoteAttachment(f.api,file,'generated-device');assert.equal(f.wire.length,2);assert.equal(f.parts.size,2);assert.equal(await uploadNoteAttachment(f.api,file,'generated-device'),id);assert.equal(f.wire.length,2);assert.equal(f.commits,1);
 f.corruptReceipt('owner');await assert.rejects(uploadNoteAttachment(f.api,file,'generated-device'),/acknowledgement does not match/);
});

test('Web mismatched resume checksum resends the selected bytes and retains the full manifest',async()=>{
 const file=generated(FILE_PART_BYTES+17),f=fixture(file);f.loseAck();await assert.rejects(uploadChatImage(f.api,file,'generated-device'),/lost ACK/);f.corruptResume();await uploadChatImage(f.api,file,'generated-device');
 assert.deepEqual(f.wire.map(item=>Number(item.path.split('/').at(-1))),[0,0,1]);assert.equal(f.wire[0].body,f.wire[1].body);assert.equal(f.commits,1);
});

for(const field of ['checksum','part','bytes'])test(`Web bad ${field} part acknowledgement cannot commit`,async()=>{
 const file=generated(1),f=fixture(file);f.corruptPart(field);await assert.rejects(uploadChatImage(f.api,file,'generated-device'),/does not match/);assert.equal(f.commits,0);
});
for(const field of ['hash','bytes','original','owner'])test(`Web wrong ${field} archive receipt never produces an attachment reference`,async()=>{
 const file=generated(1),f=fixture(file);f.corruptReceipt(field);await assert.rejects(uploadNoteAttachment(f.api,file,'generated-device'),/does not match/);
});
test('Web upload owner mismatch cannot send parts or commit',async()=>{
 const file=generated(1),f=fixture(file);f.corruptOwner();await assert.rejects(uploadChatImage(f.api,file,'generated-device'),/owner acknowledgement/);assert.equal(f.wire.length,0);assert.equal(f.commits,0);
});

test('Web cancellation before upload and during a part never commits or sends a following part',async()=>{
 const file=generated(FILE_PART_BYTES+17),before=fixture(file),controller=new AbortController();controller.abort();await assert.rejects(uploadChatImage(before.api,file,'generated-device',controller.signal),{name:'AbortError'});assert.equal(before.requests.length,0);
 const during=fixture(file),current=new AbortController();during.onPut(()=>current.abort());await assert.rejects(uploadNoteAttachment(during.api,file,'generated-device',current.signal),{name:'AbortError'});assert.equal(during.wire.length,1);assert.equal(during.commits,0);
});

test('part helper checks resume byte lengths and cancellation after its local checksum',async t=>{
 const file=generated(1),bytes=new Uint8Array(await file.arrayBuffer()),checksum=hash(bytes),sent:any[]=[];
 await uploadFilePart(file,0,FILE_PART_BYTES,{part:0,hash:checksum,bytes:2},async(body,computed)=>{sent.push(computed);assert.equal(computed,checksum);return {part:0,hash:checksum,bytes:body.byteLength};});assert.deepEqual(sent,[checksum]);
 const controller=new AbortController(),digest=crypto.subtle.digest;let sends=0;
 t.mock.method(crypto.subtle,'digest',async function(this:SubtleCrypto,algorithm:AlgorithmIdentifier,data:BufferSource){const result=await digest.call(this,algorithm,data);controller.abort();return result;});
 await assert.rejects(uploadFilePart(file,0,FILE_PART_BYTES,undefined,async()=>{sends++;return {part:0,hash:checksum,bytes:1};},controller.signal),{name:'AbortError'});assert.equal(sends,0);
});
