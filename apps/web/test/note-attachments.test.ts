import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {uploadNoteAttachment} from '../src/note-attachments.js';
import type {Api} from '../src/api.js';
const hash=(body:ArrayBuffer)=>createHash('sha256').update(new Uint8Array(body)).digest('hex');
function fixture(){let manifest:any,id=randomUUID(),lost=false,badPart=false,badCommit=false,committed=false;const parts=new Map<number,ArrayBuffer>(),sent:number[]=[];
 const ack=()=>({id,captureId:id,sourceId:manifest.sourceId,externalId:manifest.item.externalId,revision:manifest.item.revision,duplicate:false,sha256:badCommit?'wrong':manifest.sha256,sizeBytes:manifest.sizeBytes,receipt:{version:2,id,kind:'file-revision',state:'received',duplicate:false,sourceId:manifest.sourceId,externalId:manifest.item.externalId,revision:manifest.item.revision}});
 const api={request:async(path:string,init:RequestInit)=>{assert.equal((init.headers as any)['X-Mote-Ingress-Version'],'2');assert.ok(init.signal===undefined||init.signal instanceof AbortSignal);
  if(path==='/api/sources')return JSON.parse(String(init.body));
  if(path==='/api/file-sync/v1/uploads'){const incoming=JSON.parse(String(init.body));if(manifest)assert.deepEqual(incoming,manifest);manifest=incoming;return {uploadId:'generated-session',partBytes:4*1024*1024,parts:[...parts].map(([part,body])=>({part,hash:hash(body),bytes:body.byteLength})),ack:committed?ack():null};}
  if(path.endsWith('/commit')){committed=true;return ack();}
  const part=Number(path.split('/').at(-1)),body=init.body as ArrayBuffer;parts.set(part,body);sent.push(part);if(lost){lost=false;throw Error('Generated lost ACK');}return {part,hash:badPart?'wrong':hash(body),bytes:body.byteLength};
 }} as Api;
 return {api,sent,loseAck:()=>lost=true,badPart:()=>badPart=true,badCommit:()=>badCommit=true,get committed(){return committed;}};
}
test('attachment retry preserves manifest, validates resumed chunks and ends at durable receipt',async()=>{
 const f=fixture(),file=new File([new Uint8Array(5*1024*1024+1).fill(19)],'generated.wav',{type:'audio/wav',lastModified:0});f.loseAck();await assert.rejects(uploadNoteAttachment(f.api,file,'fixture'),/lost ACK/);
 const id=await uploadNoteAttachment(f.api,file,'fixture');assert.match(id,/^[a-f0-9-]{36}$/);assert.deepEqual(f.sent,[0,1]);assert.equal(await uploadNoteAttachment(f.api,file,'fixture'),id);assert.deepEqual(f.sent,[0,1]);
});
test('wrong part or archive checksum never produces an attachment reference',async()=>{
 const file=new File(['Generated'],'fixture.wav',{type:'audio/wav'}),part=fixture();part.badPart();await assert.rejects(uploadNoteAttachment(part.api,file,'fixture'),/does not match/);assert.equal(part.committed,false);
 const commit=fixture();commit.badCommit();await assert.rejects(uploadNoteAttachment(commit.api,file,'fixture'),/does not match/);
});
test('cancellation stops transport without running any OCR or ASR',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(uploadNoteAttachment(f.api,new File(['Generated'],'a.wav',{type:'audio/wav'}),'fixture',controller.signal),{name:'AbortError'});assert.deepEqual(f.sent,[]);
});
