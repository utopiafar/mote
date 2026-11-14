import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {extractUtf8,formatWork} from '../src/format-work.js';
import {observeFormatWorkers,repliesAfterExit} from './fixtures/format-worker-lifecycle.js';
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

test('an original text reply delivered after worker exit is decoded rather than reported as interrupted',async t=>{
 const lifecycle=repliesAfterExit(t),text='Generated original after process exit 🌱';
 async function* body(){yield Buffer.from(text);}
 const output=await extractUtf8(body(),Buffer.byteLength(text),new AbortController().signal);
 assert.equal(output.segments.map(segment=>segment.text).join(''),text);
 assert.equal(lifecycle.workers.length,1);await lifecycle.workers[0].closed;
 assert.equal(lifecycle.workers[0].child.exitCode,0);assert.deepEqual(lifecycle.workers[0].events,['exit','message','close']);
});

test('a decoding error delivered after worker exit retains its validation status',async t=>{
 const lifecycle=repliesAfterExit(t);
 async function* body(){yield Buffer.from([0xff]);}
 await assert.rejects(extractUtf8(body(),1,new AbortController().signal),{statusCode:500,message:'Format decoding failed: decode_failed'});
 assert.equal(lifecycle.workers.length,1);await lifecycle.workers[0].closed;
 assert.equal(lifecycle.workers[0].child.exitCode,1);assert.deepEqual(lifecycle.workers[0].events,['exit','message','close']);
});

test('cancellation after a decoder reply revokes the result and joins the worker before cleanup',async t=>{
 const controller=new AbortController(),reason=new Error('Generated owner cancellation');
 const lifecycle=observeFormatWorkers(t,({child})=>{
  // Production registered its message listener before spawn; abort after it has
  // consumed the actual reply, before the process/channel have closed.
  child.once('message',()=>controller.abort(reason));
 });
 const directory=mkdtempSync(join(tmpdir(),'mote-format-cancel-reply-')),path=join(directory,'generated.txt');writeFileSync(path,'Generated cancelled reply');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 await assert.rejects(formatWork({kind:'text',path,maxBytes:1024,chunkCharacters:4000},controller.signal),error=>error===reason);
 assert.equal(lifecycle.workers.length,1);assert.equal(lifecycle.workers[0].events.at(-1),'close','cancellation waits for physical process and IPC cleanup');
});

test('an externally killed decoder reports its task and signal rather than owner cancellation or timeout',async t=>{
 const lifecycle=observeFormatWorkers(t,({child})=>{child.kill('SIGKILL');});
 const directory=mkdtempSync(join(tmpdir(),'mote-format-killed-')),path=join(directory,'generated.txt');writeFileSync(path,'Generated interrupted decoding');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 await assert.rejects(formatWork({kind:'text',path,maxBytes:1024,chunkCharacters:4000}),{statusCode:503,message:'Format worker interrupted (text; exit code null; signal SIGKILL)'});
 assert.equal(lifecycle.workers.length,1);assert.equal(lifecycle.workers[0].child.signalCode,'SIGKILL');assert.equal(lifecycle.workers[0].events.at(-1),'close');
});

test('an unavailable decoder process preserves the OS launch error and releases admission for the next original',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-format-launch-')),path=join(directory,'generated.txt');writeFileSync(path,'Generated next original');
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const fork=childProcess.fork;
 // Launch a real process with a generated missing executable, rather than
 // exhausting the test host's process/memory limits or fabricating an IPC reply.
 t.mock.method(childProcess,'fork',((module:URL,args:string[],options:childProcess.ForkOptions)=>fork(module,args,{...options,execPath:join(directory,'unavailable-node')})) as typeof fork);
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const task={kind:'text' as const,path,maxBytes:1024,chunkCharacters:4000};
 await assert.rejects(formatWork(task),{code:'ENOENT'});
 t.mock.restoreAll();syncBuiltinESMExports();
 assert.equal((await formatWork(task)).segments[0].text,'Generated next original');
});
