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
