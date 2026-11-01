import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Api} from '../src/api.js';
import {OperationFeed,affectedResource} from '../src/operation-feed.js';
import {resources} from '../src/resource-cache.js';
import {Store} from '../../server/src/store.js';
import {ExecutionEngine} from '../../server/src/execution-engine.js';
import {Operations} from '../../server/src/operations.js';
import {publishOperationChange} from '../../server/src/operation-projection.js';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(ready:()=>boolean){for(let attempt=0;attempt<100;attempt++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(ready(),'the real feed publishes the current receipt');}
const paths=[
 '/api/library/browse?limit=3','/api/insight-runs','/api/conversations?limit=3','/api/devices/first-data','/api/insights?limit=3',
 '/api/materials?limit=24','/api/sources','/api/files?limit=30','/api/capture-browser/timeline?after=generated','/api/capture-browser/timeline/members?group=generated',
 '/api/memories?limit=30','/api/memory-jobs','/api/context-trees','/api/memory-spaces','/api/query-runs/generated','/api/conversations/generated',
 '/api/insight-runs/generated','/api/operations?limit=20','/api/operations/capture%3Agenerated-0','/api/work-activity','/api/model-settings',
];

test('ten minutes of generated capture hints retain evidence withdrawal reads without refreshing fixed insight receipts',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-feed-replay-')),store=new Store(directory),engine=new ExecutionEngine(store);
 await engine.close();t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const operations=new Operations(store);
 t.mock.timers.enable({apis:['setTimeout']});
 for(const stages of [2,3]){
  const reads=new Map<string,number>(),invalidations=new Map<string,number>();let polls=0,nonempty=0,returnedIds=0,resets=0;
  const api={request:async(path:string)=>{
   if(path.startsWith('/api/operations/changes?')){polls++;const change=operations.changes(Number(new URL('http://fixture'+path).searchParams.get('since')));if(change.reset)resets++;if(change.ids.length)nonempty++;returnedIds+=change.ids.length;return change;}
   reads.set(path,(reads.get(path)??0)+1);return {generated:true};
  }} as Api;
  const offs=paths.map(path=>{const resource=resources(api).get(path),invalidate=resource.invalidate.bind(resource);resource.invalidate=()=>{invalidations.set(path,(invalidations.get(path)??0)+1);invalidate();};return resource.subscribe(()=>{});});
  await turn();const feed=new OperationFeed(api),stop=feed.subscribe(()=>{});await turn();
  assert.equal(polls,1);assert.equal(resets,1,'initial cursor reset is measured separately');
  reads.clear();invalidations.clear();polls=0;nonempty=0;returnedIds=0;resets=0;
  let rawChanges=0;
  for(let clock=500;clock<=600_000;clock+=500){
   for(let capture=0;capture<120;capture++)for(let stage=0;stage<stages;stage++)if(clock===1000+capture*5000+stage*1000){publishOperationChange(store,'capture:generated-'+capture);rawChanges++;}
   t.mock.timers.tick(500);await turn();
  }
  stop();offs.forEach(off=>off());
  const result={durationMs:600_000,captureCount:120,stages,rawChanges,feedPolls:polls,nonemptyBatches:nonempty,returnedIds,resets,resources:paths.map(path=>({path,invalidations:invalidations.get(path)??0,reads:reads.get(path)??0}))};
  t.diagnostic(JSON.stringify(result));
  assert.equal(rawChanges,120*stages);assert.equal(polls,400);assert.equal(resets,0);
  assert.equal(reads.get('/api/insight-runs')??0,0,'fixed receipts do not change with capture processing');
  for(const path of ['/api/library/browse?limit=3','/api/conversations/generated','/api/insight-runs/generated','/api/memories?limit=30'])assert.equal(reads.get(path),nonempty,path+' retains live evidence reads');
  for(const path of ['/api/context-trees','/api/model-settings','/api/capture-browser/timeline?after=generated','/api/capture-browser/timeline/members?group=generated'])assert.equal(reads.get(path)??0,0,path);
 }
});

test('real owner review lifecycle publishes insight hints while deleting an original withdraws reports, not fixed receipts',async t=>{
 const {buildApp}=await import('../../server/src/app.js');
 const directory=mkdtempSync(join(tmpdir(),'mote-insight-feed-contract-')),token='generated-insight-feed-owner-token';
 let release!:()=>void,entered!:()=>void;
 let gate=new Promise<void>(resolve=>release=resolve);const running=new Promise<void>(resolve=>entered=resolve);
 const node=await buildApp({dataDir:directory,token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{backgroundWorker:false,agent:{configured:true,query:async()=>{entered();await gate;return {answer:JSON.stringify({title:'Generated report',markdown:'Generated report',html:'<p>Generated report</p>'}),citations:[],trace:[],runId:randomUUID()};},close:async()=>release()}});
 let stop=()=>{},off=()=>{};
 t.after(async()=>{stop();off();release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
 const read=async(path:string)=>{const response=await node.app.inject({url:path,headers});assert.equal(response.statusCode,200,response.body);return response.json();};
 const changes=async(since:number)=>read('/api/operations/changes?since='+since);
 const api={request:read} as Api,receipt=resources(api).get<{items:{id:string;status:string}[]}>('/api/insight-runs');
 off=receipt.subscribe(()=>{});stop=new OperationFeed(api,5).subscribe(()=>{});
 await until(()=>receipt.getSnapshot().data?.items.length===0);
 let cursor=(await changes(Number.MAX_SAFE_INTEGER)).cursor;
 const id=randomUUID();const start=await node.app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:id}});assert.equal(start.statusCode,202,start.body);await running;
 const started=await changes(cursor);assert.ok(started.ids.includes('insight:'+id));assert.equal(affectedResource('/api/insight-runs',new Set(started.ids),started.reset),true);cursor=started.cursor;
 assert.equal((await read('/api/insight-runs')).items.find((item:any)=>item.id===id).status,'running');
 await until(()=>receipt.getSnapshot().data?.items.some(item=>item.id===id&&item.status==='running')??false);
 const captureId=randomUUID();const captured=await node.app.inject({method:'POST',url:'/api/captures',headers,payload:{id:captureId,deviceId:'generated',deviceName:'Generated Mac',platform:'macos',capturedAt:new Date().toISOString(),durationMs:1000,appId:'generated.app',appName:'Generated original',source:'activity',ocrText:'',privacy:{collection:'activity',mode:'none'}}});assert.equal(captured.statusCode,201,captured.body);
 release();await node.insightRuns.close();
 const completed=await changes(cursor);assert.ok(completed.ids.includes('insight:'+id));assert.equal(affectedResource('/api/insight-runs',new Set(completed.ids),completed.reset),true);
 const detail=await read('/api/insight-runs/'+id),before=await read('/api/insight-runs');assert.equal(detail.status,'completed');assert.equal(detail.result.artifact.title,'Generated report');
 await until(()=>receipt.getSnapshot().data?.items.some(item=>item.id===id&&item.status==='completed')??false);
 assert.equal((await read('/api/insights')).items.length,1);
 const deletionCursor=(await changes(Number.MAX_SAFE_INTEGER)).cursor;
 const deleted=await node.app.inject({method:'DELETE',url:'/api/captures/'+captureId,headers});assert.equal(deleted.statusCode,200,deleted.body);
 assert.deepEqual(await read('/api/insight-runs'),before,'capture deletion cannot mutate the fixed run receipt');assert.equal((await read('/api/insight-runs/'+id)).result,undefined);assert.equal((await read('/api/insights')).items.length,0);
 assert.equal((await node.app.inject({url:'/api/insights/'+detail.result.runId,headers})).statusCode,404);
 t.diagnostic('Original deletion operation hints: '+JSON.stringify(await changes(deletionCursor)));
 // Deletion is not guaranteed to publish an operation hint. Preserve all
 // existing detail/history mappings and their independent revalidation paths.
 for(const path of ['/api/insight-runs/'+id,'/api/insights','/api/insights/'+detail.result.runId,'/api/conversations/generated'])assert.equal(affectedResource(path,new Set(['capture:'+captureId]),false),true,path);
 cursor=(await changes(Number.MAX_SAFE_INTEGER)).cursor;
 gate=new Promise<void>(resolve=>release=resolve);
 const cancelledId=randomUUID();assert.equal((await node.app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:cancelledId}})).statusCode,202);
 const cancelled=await node.app.inject({method:'POST',url:'/api/insight-runs/'+cancelledId+'/cancel',headers});assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().status,'cancelled');
 const stopped=await changes(cursor);assert.ok(stopped.ids.includes('insight:'+cancelledId));assert.equal(affectedResource('/api/insight-runs',new Set(stopped.ids),stopped.reset),true);assert.equal((await read('/api/insight-runs')).items.find((item:any)=>item.id===cancelledId).status,'cancelled');
 await until(()=>receipt.getSnapshot().data?.items.some(item=>item.id===cancelledId&&item.status==='cancelled')??false);
});
