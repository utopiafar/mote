import test from 'node:test';
import assert from 'node:assert/strict';
import type {ImportJob} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {ApiError,type Api} from '../src/api.js';
import {ImportQueue,type ImportDraft} from '../src/import-queue.js';
configureLocale(()=> 'zh-CN');

function draft(name:string):ImportDraft{return {name,instruction:'',sourcePackId:'',source:{kind:'files',files:[new File(['Generated '+name],name+'.txt')]}};}
function gate(){let resolve!:(value:any)=>void;return {promise:new Promise<any>(done=>resolve=done),resolve:(value:any)=>resolve(value)};}
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(check(),'Generated queue did not settle');}
function fixture(t:any,concurrency=2){
  const begins:{id:string;name:string}[]=[],writes:any[]=[],receipts=new Map<string,ImportJob>(),gates=new Map<string,ReturnType<typeof gate>>();
  let loseCreate=false;
  const api={request:async(path:string,init:RequestInit)=>{
    const input=JSON.parse(String(init.body));
    if(path==='/api/import-uploads'){begins.push(input);const held=gates.get(input.name);return held?held.promise:{id:input.id,fileId:'archive:'+input.id,partBytes:4,parts:[]};}
    assert.equal(path,'/api/imports');writes.push(input);
    if(!receipts.has(input.requestId))receipts.set(input.requestId,{id:input.requestId,name:input.name,status:'awaiting_confirmation'} as ImportJob);
    if(loseCreate){loseCreate=false;throw Error('Generated lost response');}
    return receipts.get(input.requestId);
  }} as Api;
  const queue=new ImportQueue(api,concurrency);t.after(()=>queue.close());
  return {queue,begins,writes,receipts,gates,loseCreate:()=>{loseCreate=true;}};
}

test('admission is bounded, batches freeze their inputs and previews release slots',async t=>{
  const f=fixture(t),hold=gate(),input=draft('first');f.gates.set('first.txt',hold);
  const first=f.queue.enqueue(input),second=f.queue.enqueue(draft('second')),third=f.queue.enqueue(draft('third'));
  input.name='Changed draft';input.instruction='Changed instructions';(input.source as {files:File[]}).files.push(new File(['Generated extra'],'extra.txt'));
  assert.equal(f.begins.length,2);assert.equal(f.queue.getSnapshot().entries.find(entry=>entry.id===third)!.state,'queued');
  await until(()=>f.writes.length===2);
  assert.deepEqual(f.writes.map(write=>write.name),['second','third']);
  assert.equal(f.queue.getSnapshot().entries.find(entry=>entry.id===first)!.state,'uploading');
  assert.equal(f.queue.getSnapshot().entries.find(entry=>entry.id===second)!.job!.status,'awaiting_confirmation');
  hold.resolve({id:f.begins[0].id,fileId:'archive:first',partBytes:4,parts:[]});await until(()=>f.writes.length===3);
  assert.equal(f.writes[2].name,'first');assert.equal(f.writes[2].instruction,'');assert.deepEqual(f.writes[2].archivedFileIds,['archive:first']);
  assert.equal(f.queue.draft(first)!.source.kind,'files');assert.equal((f.queue.draft(first)!.source as {files:File[]}).files.length,0,'Server ownership releases File references');
});

test('paused queued and running batches retain identity without holding up later admissions',async t=>{
  const f=fixture(t,1),hold=gate();f.gates.set('first.txt',hold);
  const first=f.queue.enqueue(draft('first')),second=f.queue.enqueue(draft('second')),third=f.queue.enqueue(draft('third'));
  f.queue.pause(second);f.queue.pause(first);
  assert.equal(f.queue.getSnapshot().entries.find(entry=>entry.id===first)!.state,'paused');
  // Uncooperative transport is fenced even if its promise resolves after pause.
  hold.resolve({id:f.begins[0].id,fileId:'archive:late',partBytes:4,parts:[]});await until(()=>f.writes.length===1);
  assert.equal(f.writes[0].requestId,third);assert.equal(f.begins.length,2);
  f.gates.delete('first.txt');f.queue.retry(first);f.queue.retry(second);await until(()=>f.writes.length===3);
  assert.equal(f.begins[0].id,f.begins[2].id);assert.deepEqual(f.writes.map(write=>write.requestId),[third,first,second]);
});

test('lost create response retries the identical request and creates one receipt',async t=>{
  const f=fixture(t);f.loseCreate();const id=f.queue.enqueue(draft('first'));
  await until(()=>f.queue.getSnapshot().entries[0].state==='failed');f.queue.retry(id);await until(()=>f.queue.getSnapshot().entries[0].state==='submitted');
  assert.deepEqual(f.writes[0],f.writes[1]);assert.equal(f.receipts.size,1);assert.equal(f.begins.length,1,'Committed originals are not re-negotiated');
  f.queue.enqueue(draft('second'));await until(()=>f.writes.length===3);assert.notEqual(f.writes[1].requestId,f.writes[2].requestId);
});

test('connection close aborts admissions and fences late responses even after restarting',async t=>{
  const f=fixture(t),hold=gate();f.gates.set('old.txt',hold);const old=f.queue.enqueue(draft('old'));f.queue.close();
  assert.deepEqual(f.queue.getSnapshot().entries,[]);assert.throws(()=>f.queue.enqueue(draft('blocked')),/登录连接已结束/);
  f.queue.start();const fresh=f.queue.enqueue(draft('fresh'));hold.resolve({id:f.begins[0].id,fileId:'archive:old',partBytes:4,parts:[]});
  await until(()=>f.writes.length===1);assert.equal(f.writes[0].requestId,fresh);assert.notEqual(f.writes[0].requestId,old);
  assert.equal(f.queue.getSnapshot().entries.length,1);
});

test('missing local files and missing directories expose source-specific recovery and do not block other batches',async t=>{
  const file=new File(['Generated missing file'],'missing.txt');Object.defineProperty(file,'slice',{value:()=>({arrayBuffer:async()=>{throw new DOMException('Generated missing file','NotFoundError');}})});
  const api={request:async(path:string,init:RequestInit)=>{const input=JSON.parse(String(init.body));if(path==='/api/import-uploads')return {id:input.id,partBytes:4,parts:[]};throw new ApiError('Generated directory failure',422,undefined,'import_directory_missing');}} as Api;
  const queue=new ImportQueue(api);t.after(()=>queue.close());
  queue.enqueue({...draft('missing'),source:{kind:'files',files:[file]}});queue.enqueue({...draft('directory'),source:{kind:'directory',path:'/generated/missing'}});
  await until(()=>queue.getSnapshot().entries.every(entry=>entry.state==='failed'));
  assert.deepEqual(queue.getSnapshot().entries.map(entry=>entry.failure!.recovery),['files','directory']);
  assert.match(queue.getSnapshot().entries[0].failure!.message,/重新选择文件/);
  assert.match(queue.getSnapshot().entries[1].failure!.message,/目录不存在/);
});

test('discard aborts only its admission; duplicate paths are rejected before upload',async t=>{
  const f=fixture(t),hold=gate();f.gates.set('first.txt',hold);
  const first=f.queue.enqueue(draft('first'));f.queue.enqueue(draft('second'));f.queue.discard(first);
  hold.resolve({id:f.begins[0].id,fileId:'archive:first',partBytes:4,parts:[]});await until(()=>f.writes.length===1);
  assert.equal(f.writes[0].name,'second');assert.equal(f.queue.getSnapshot().entries.length,1);
  assert.throws(()=>f.queue.enqueue({...draft('duplicate'),source:{kind:'files',files:[new File(['one'],'same.txt'),new File(['two'],'same.txt')]}}),/文件路径不能重复/);
  assert.equal(f.begins.length,2);
});

test('request deadlines fail one admission and release its slot without changing another batch',async t=>{
 const deadline=new AbortController(),originalTimeout=AbortSignal.timeout;let count=0;
 t.mock.method(AbortSignal,'timeout',(ms:number)=>++count===1?deadline.signal:originalTimeout(ms));
 const writes:string[]=[];
 const api={request:async(path:string,init:RequestInit)=>{
  const input=JSON.parse(String(init.body));
  if(path==='/api/import-uploads'){
   if(input.name==='slow.txt')return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));
   return {id:input.id,fileId:'archive:'+input.id,partBytes:4,parts:[]};
  }
  writes.push(input.name);return {id:input.requestId,name:input.name,status:'completed'};
 }} as Api;
 const queue=new ImportQueue(api,1);t.after(()=>queue.close());queue.enqueue(draft('slow'));queue.enqueue(draft('next'));
 deadline.abort(new DOMException('Generated deadline','TimeoutError'));await until(()=>writes.length===1);
 assert.deepEqual(writes,['next']);assert.equal(queue.getSnapshot().entries[0].state,'failed');assert.match(queue.getSnapshot().entries[0].failure!.message,/超时/);
});

test('server rate limiting waits automatically, preserves create identity and backpressures later admissions',async t=>{
 const writes:any[]=[],begins:string[]=[];let limited=true;
 const api={request:async(path:string,init:RequestInit)=>{
  const input=JSON.parse(String(init.body));
  if(path==='/api/import-uploads'){begins.push(input.name);return {id:input.id,fileId:'archive:'+input.id,partBytes:4,parts:[]};}
  writes.push(input);if(limited){limited=false;throw new ApiError('Generated rate limit',429,undefined,'api_rate_limited',100);}
  return {id:input.requestId,name:input.name,status:'completed'};
 }} as Api;
 const queue=new ImportQueue(api,1);t.after(()=>queue.close());const first=queue.enqueue(draft('first'));queue.enqueue(draft('second'));
 await until(()=>queue.getSnapshot().entries[0].state==='waiting');assert.deepEqual(begins,['first.txt']);assert.equal(queue.getSnapshot().entries[1].state,'queued');
 await until(()=>queue.getSnapshot().entries.every(entry=>entry.state==='submitted'));
 assert.deepEqual(writes[0],writes[1]);assert.equal(writes[1].requestId,first);assert.equal(writes[2].name,'second');
});

test('server history reconciles a lost create receipt and releases the failed local admission',async t=>{
 const f=fixture(t);f.loseCreate();const id=f.queue.enqueue(draft('first'));
 await until(()=>f.queue.getSnapshot().entries[0].state==='failed');assert.equal(f.receipts.has(id),true);
 f.queue.acknowledge([...f.receipts.keys()]);assert.deepEqual(f.queue.getSnapshot().entries,[]);assert.equal(f.queue.draft(id),undefined);assert.equal(f.writes.length,1);
});

test('repeated transport limit windows advance past archived prefixes and eventually admit the whole batch',async t=>{
 const originals=Array.from({length:6},(_,index)=>new File(['Generated '+index],'original-'+index+'.txt')),begins:string[]=[],writes:any[]=[];let remaining=2;
 const api={request:async(path:string,init:RequestInit)=>{
  const input=JSON.parse(String(init.body));
  if(path==='/api/import-uploads'){
   if(!remaining--){remaining=2;throw new ApiError('Generated transport limit',429,undefined,'api_rate_limited',20);}
   begins.push(input.name);return {id:input.id,fileId:'archive:'+input.id,partBytes:4,parts:[]};
  }
  writes.push(input);return {id:input.requestId,name:input.name,status:'completed'};
 }} as Api;
 const queue=new ImportQueue(api,1);t.after(()=>queue.close());queue.enqueue({...draft('batch'),source:{kind:'files',files:originals}});
 await until(()=>writes.length===1);assert.deepEqual(begins,originals.map(file=>file.name));assert.equal(writes[0].archivedFileIds.length,6);assert.equal(queue.getSnapshot().entries[0].uploadedBytes,originals.reduce((n,file)=>n+file.size,0));
});
