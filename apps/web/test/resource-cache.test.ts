import test from 'node:test';
import assert from 'node:assert/strict';
import type {Api} from '../src/api.js';
import {resources} from '../src/resource-cache.js';
import {OperationFeed} from '../src/operation-feed.js';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fake(){const calls:{path:string;signal:AbortSignal;resolve:(v:unknown)=>void;reject:(e:unknown)=>void}[]=[];const api={request:(path:string,init:any)=>new Promise((resolve,reject)=>calls.push({path,signal:init.signal,resolve,reject}))} as Api;return {api,calls};}
test('shared read cache deduplicates subscribers, fences stale refreshes and isolates sessions',async()=>{
 const {api,calls}=fake(),resource=resources(api).get<{n:number}>('/api/operations');const off=resource.subscribe(()=>{}),second=resource.subscribe(()=>{});assert.equal(calls.length,1);
 resource.refresh();assert.equal(calls[0].signal.aborted,true);calls[1].resolve({n:2});await turn();calls[0].resolve({n:1});await turn();assert.equal(resource.getSnapshot().data!.n,2);
 second();assert.equal(resource.observed,true);resource.refresh();off();assert.equal(calls[2].signal.aborted,true);calls[2].resolve({n:3});await turn();assert.equal(resource.getSnapshot().data!.n,2);
 const again=resource.subscribe(()=>{});assert.equal(calls.length,4);calls[3].resolve({n:4});await turn();again();assert.equal(resource.getSnapshot().data!.n,4);
 const other=fake();assert.equal(resources(other.api).get('/api/operations').getSnapshot().data,undefined);
});
test('failed cache reads retain prior data and remain retryable without a request loop',async()=>{
 const {api,calls}=fake(),resource=resources(api).get('/api/operations'),off=resource.subscribe(()=>{});calls[0].resolve({value:1});await turn();resource.refresh();calls[1].reject(Error('offline'));await turn();assert.deepEqual(resource.getSnapshot().data,{value:1});assert.equal(resource.getSnapshot().loading,false);assert.equal(calls.length,2);resource.refresh();calls[2].resolve({value:2});await turn();assert.equal(resource.getSnapshot().error,undefined);off();
});
test('change subscription refreshes affected active resources and stops after last observer',async()=>{
 const {api,calls}=fake(),cache=resources(api),list=cache.get('/api/operations'),detail=cache.get('/api/operations/file%3Aa'),other=cache.get('/api/operations/file%3Ab');
 const offs=[list,detail,other].map(resource=>resource.subscribe(()=>{}));for(const call of calls)call.resolve({});await turn();
 const feed=new OperationFeed(api,5),off=feed.subscribe(()=>{}),second=feed.subscribe(()=>{});assert.equal(calls.length,4);calls[3].resolve({ids:['file:a'],cursor:12,hasMore:false,reset:false});await turn();assert.deepEqual(calls.slice(4).map(c=>c.path).sort(),['/api/operations','/api/operations/file%3Aa']);for(const call of calls.slice(4))call.resolve({});await turn();
 second();off();offs.forEach(off=>off());const count=calls.length;await new Promise(r=>setTimeout(r,20));assert.equal(calls.length,count);
});

test('revocation and deletion remove cached evidence while transport failures retain prior data',async()=>{
 const {ApiError}=await import('../src/api.js');
 for(const status of [401,403,404,410]){const {api,calls}=fake(),resource=resources(api).get('/api/captures/generated'),off=resource.subscribe(()=>{});calls[0].resolve({text:'generated original'});await turn();resource.refresh();calls[1].reject(new ApiError('unavailable',status));await turn();assert.equal(resource.getSnapshot().data,undefined);assert.equal(resource.getSnapshot().error instanceof ApiError,true);off();}
});
test('operation changes invalidate the shared domain resources without touching unrelated settings',async()=>{
 const {affectedResource}=await import('../src/operation-feed.js');
 const kinds={memory:['/api/memories?limit=30','/api/memory-jobs/x'],file:['/api/files/id','/api/source-items?sourceId=x'],capture:['/api/capture-browser/id','/api/captures?limit=30'],import:['/api/imports/id','/api/memories?limit=30'],query:['/api/query-runs/id','/api/conversations/id'],insight:['/api/insight-runs/id','/api/insights']};
 for(const [kind,paths] of Object.entries(kinds)){for(const path of paths)assert.equal(affectedResource(path,new Set([kind+':x']),false),true,path);assert.equal(affectedResource('/api/model-settings',new Set([kind+':x']),false),false);}
 assert.equal(affectedResource('/api/memories',new Set(['query:x']),false),false);assert.equal(affectedResource('/api/memory-jobs/x',new Set(),true),true);
});
test('reopening an unobserved detail revalidates its immutable ref after external deletion',async()=>{
 const {ApiError}=await import('../src/api.js'),{api,calls}=fake(),resource=resources(api).get('/api/capture-browser/generated');let off=resource.subscribe(()=>{});calls[0].resolve({text:'old original'});await turn();off();off=resource.subscribe(()=>{});assert.equal(calls.length,2);calls[1].reject(new ApiError('deleted',404));await turn();assert.equal(resource.getSnapshot().data,undefined);off();
});

test('imperative page reads share a generation and cancel independently of another observer',async()=>{
 const {readResource}=await import('../src/resource-cache.js');const {api,calls}=fake(),one=new AbortController(),two=new AbortController();
 const a=readResource<{n:number}>(api,'/api/generated',one.signal),b=readResource<{n:number}>(api,'/api/generated',two.signal);assert.equal(calls.length,1);const rejected=assert.rejects(a,{name:'AbortError'});one.abort();await rejected;assert.equal(calls[0].signal.aborted,false);calls[0].resolve({n:2});assert.deepEqual(await b,{n:2});
 const c=new AbortController(),pending=readResource(api,'/api/generated',c.signal),cancelled=assert.rejects(pending,{name:'AbortError'});c.abort();await cancelled;assert.equal(calls[1].signal.aborted,true);calls[1].resolve({n:3});await turn();assert.deepEqual(resources(api).get('/api/generated').getSnapshot().data,{n:2});
});
test('shared polling performs one refresh for multiple readers, pauses while hidden and stops when detached',async t=>{
 const {api,calls}=fake(),resource=resources(api).get('/api/connector');const off1=resource.subscribe(()=>{}),off2=resource.subscribe(()=>{}),poll1=resource.poll(250),poll2=resource.poll(250);calls[0].resolve({});await turn();await new Promise(r=>setTimeout(r,270));assert.equal(calls.length,2);calls[1].resolve({});await turn();const before=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:{hidden:true},configurable:true});t.after(()=>{if(before)Object.defineProperty(globalThis,'document',before);else Reflect.deleteProperty(globalThis,'document');});await new Promise(r=>setTimeout(r,270));assert.equal(calls.length,2,'Hidden views do not poll');off1();poll1();off2();poll2();await new Promise(r=>setTimeout(r,270));assert.equal(calls.length,2);
});
