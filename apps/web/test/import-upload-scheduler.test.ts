import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {uploadImportFiles} from '../src/import-upload-scheduler.js';
import type {Api} from '../src/api.js';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){const uploads=new Map<string,{name:string;parts:Map<number,Uint8Array>;fileId?:string}>(),events:string[]=[],attempts:{id:string;part:number}[]=[];let failOnce=false,badAck=false;
 const api={request:async(path:string,init:RequestInit)=>{if(path==='/api/import-uploads'){const body=JSON.parse(String(init.body));if(!uploads.has(body.id))uploads.set(body.id,{name:body.name,parts:new Map()});const upload=uploads.get(body.id)!;return {id:body.id,partBytes:4*1024*1024,fileId:upload.fileId,parts:[...upload.parts].map(([part,bytes])=>({part,hash:hash(bytes),bytes:bytes.byteLength}))};}const [,id,operation,index]=path.match(/^\/api\/import-uploads\/([^/]+)\/(parts|commit)(?:\/(\d+))?$/)!;const upload=uploads.get(id)!;if(operation==='parts'){const part=Number(index),bytes=new Uint8Array(init.body as ArrayBuffer);attempts.push({id,part});upload.parts.set(part,bytes);events.push(upload.name+':'+part);if(failOnce){failOnce=false;throw Error('generated lost ACK');}return {part,hash:badAck?'wrong':hash(bytes),bytes:bytes.byteLength};}events.push(upload.name+':commit');upload.fileId='archived:'+id;return {id:upload.fileId};}} as Api;
 return {api,uploads,events,attempts,loseAck:()=>failOnce=true,wrongAck:()=>badAck=true};}
test('one large original yields to 400 dated small files and preserves original result order and hashes',async()=>{
 const f=fixture(),large=new File([new Uint8Array(20*1024*1024+13).fill(71)],'large.bin'),files=[large,...Array.from({length:400},(_,i)=>new File(['Generated '+i],new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10)+'.txt'))];const progress:number[]=[],ids=new WeakMap<File,string>();
 const result=await uploadImportFiles(f.api,files,ids,n=>progress.push(n));assert.equal(result.length,401);assert.deepEqual(result,files.map(file=>'archived:'+ids.get(file)));assert.equal(f.events[0],'large.bin:0');assert.ok(f.events.indexOf(files[400].name+':commit')<f.events.indexOf('large.bin:1'));assert.equal(f.events.at(-1),'large.bin:commit');assert.equal(progress.at(-1),files.reduce((n,file)=>n+file.size,0));assert.ok(progress.every((n,i)=>!i||n>=progress[i-1]));
 const parts=f.uploads.get(ids.get(large)!)!.parts;assert.equal(hash(Buffer.concat([...parts.values()])),hash(new Uint8Array(await large.arrayBuffer())));
});
test('retry after a lost ACK verifies and skips its fixed part without mixing sessions',async()=>{
 const f=fixture(),file=new File([new Uint8Array(8*1024*1024+7).fill(39)],'resume.bin'),ids=new WeakMap<File,string>();f.loseAck();await assert.rejects(uploadImportFiles(f.api,[file],ids,()=>{}),/lost ACK/);const id=ids.get(file);assert.equal(f.events.includes('resume.bin:commit'),false);await uploadImportFiles(f.api,[file],ids,()=>{});assert.equal(ids.get(file),id);assert.deepEqual(f.attempts.map(item=>item.part),[0,1,2]);assert.equal(f.uploads.size,1);
});
test('mismatched acknowledgements preserve the session and cannot commit an original',async()=>{const f=fixture(),file=new File(['generated'],'ack.txt'),ids=new WeakMap<File,string>();f.wrongAck();await assert.rejects(uploadImportFiles(f.api,[file],ids,()=>{}),/does not match/);assert.ok(ids.get(file));assert.equal(f.events.includes('ack.txt:commit'),false);});
