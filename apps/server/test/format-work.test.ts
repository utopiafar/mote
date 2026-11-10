import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractUtf8,formatWork} from '../src/format-work.js';
test('file extraction uses the same strict UTF-8 decoder without splitting surrogate pairs',async()=>{
 const text='x'.repeat(3999)+'🌱'+'合成'.repeat(4000),bytes=Buffer.from(text);
 async function* body(){for(let i=0;i<bytes.length;i+=997)yield bytes.subarray(i,i+997);}
 const output=await extractUtf8(body(),bytes.length,new AbortController().signal);assert.equal(output.segments.map(s=>s.text).join(''),text);assert.ok(output.segments.every(s=>s.text.length<=4000&&!/[\uD800-\uDBFF]$/.test(s.text)));
 async function* invalid(){yield Buffer.from([0xff]);}await assert.rejects(extractUtf8(invalid(),1,new AbortController().signal));
});
test('aborted decoding does not consume a worker slot and leaves no resumable model call',async()=>{
 const controller=new AbortController();controller.abort();async function* body(){yield Buffer.from('fixture');}
 await assert.rejects(extractUtf8(body(),7,controller.signal));
 const result=await extractUtf8(body(),7,new AbortController().signal);assert.equal(result.segments[0].text,'fixture');
});

test('plain decoding no longer rejects more than 10000 chunks while the 32 MiB manifest capacity remains',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-plain-limit-')),path=join(directory,'generated.txt'),manifest=join(directory,'generated.jsonl'),text='Generated plain input',createdAt='2025-01-01T00:00:00.000Z';
 writeFileSync(path,text);t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const hash=createHash('sha256').update(text).digest('hex'),file=(index:number)=>({id:randomUUID(),hash,sizeBytes:Buffer.byteLength(text),name:`generated-${index}.txt`,relativePath:`generated-${index}.txt`,mimeType:'text/plain',createdAt});
 const result=await formatWork({kind:'plain',inputs:Array.from({length:10001},(_,index)=>({file:file(index),path})),createdAt,manifest});
 assert.equal(result.count,10001);assert.ok(result.samples.length>0);
});

test('a queued format worker receives a fresh execution budget after occupied workers time out',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-format-wait-')),path=join(directory,'generated.txt');writeFileSync(path,'Generated queued decoding');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));t.mock.timers.enable({apis:['setTimeout']});
 const task={kind:'text' as const,path,maxBytes:1024,chunkCharacters:4000};
 const first=assert.rejects(formatWork(task),{name:'TimeoutError'}),second=assert.rejects(formatWork(task),{name:'TimeoutError'}),queued=formatWork(task);
 // All three calls have entered the production queue; only the first two have
 // child processes. Their timeout must not also expire the queued third call.
 await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(15*60*1000+1);
 await Promise.all([first,second]);const result=await queued;
 assert.equal(result.segments.map(segment=>segment.text).join(''),'Generated queued decoding');
});
