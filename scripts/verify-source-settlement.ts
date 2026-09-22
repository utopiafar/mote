/** Generated fixtures: actual desktop outbox -> loopback HTTP -> central SQLite. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../apps/server/src/app.js';
import {DirectoryCatalog} from '../apps/desktop/src/directory-catalog.js';
import {SourceSync,sourceHash} from '../apps/desktop/src/source-sync.js';
import {sourceWork} from '../apps/desktop/src/background.js';
import {sourceState,type StatePatch} from '../apps/desktop/src/source-state-store.js';
import type {ScannedItem,SourceDefinition,SourceRequest} from '../apps/desktop/src/source-types.js';
const rttMs=Number(process.env.MOTE_REVIEW_RTT_MS??0);
assert.ok(Number.isFinite(rttMs)&&rttMs>=0&&rttMs<=5000,'Injected RTT must be between 0 and 5000 ms');
const directory=await mkdtemp(join(tmpdir(),'mote-settlement-'));
const token='generated-source-settlement-token-000000000';
const source:SourceDefinition={id:'generated-source',name:'Generated source',kind:'local-files',deviceId:'generated-mac',platform:'macos',retention:'reference',enabled:true};
const file=(index:number):ScannedItem=>({externalId:'file-'+index,title:'Generated '+index+'.txt',text:'',kind:'file',layer:'reference',document:{fileIndex:{version:1,fileId:'file-'+index,contentVersion:sourceHash('fixture-'+index),mode:'catalog',coverage:'none',parser:'none',status:'ready',totalCharacters:0,offset:0,length:0,allowRead:false}},metadata:{version:1,file:{sizeBytes:100}}});
const scan=(items:ScannedItem[])=>({items,seen:items.map(item=>item.externalId),complete:false,skipped:0});
const node=await buildApp({dataDir:join(directory,'central'),token,tokenPath:'unused',dataKey:undefined,host:'127.0.0.1',port:0,maxStorageBytes:200*1024*1024,maxExportBytes:20*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'});
const originalRun=sourceWork.run.bind(sourceWork);
try{
 await node.app.listen({host:'127.0.0.1',port:0});
 const latencies:number[]=[],batches:number[]=[];
 const request:SourceRequest=async(path,body,method)=>{
  const began=performance.now();if(rttMs)await delay(rttMs/2);
  const response=await fetch(node.app.listeningOrigin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Object.assign(Error('Generated HTTP failure'),{httpStatus:response.status});
  if(path.endsWith('/manifests'))batches.push((body as {items:unknown[]}).items.length);
  const result=await response.json();if(rttMs)await delay(rttMs/2);latencies.push(performance.now()-began);return result;
 };
 const path=join(directory,'device.json');let engine=new SourceSync(path);await engine.initialize();
 await request('/api/sources',source,'POST');node.store.db.prepare('INSERT INTO file_forgotten VALUES(?,?)').run(source.id,'file-37');
 await engine.stage(scan(Array.from({length:100},(_,i)=>file(i))),false);
 // Simulate interruption after the server committed but before the client persisted ACKs.
 let interrupted=false;
 sourceWork.run=((input:any,...rest:any[])=>{
  if(input.kind==='source-state'&&input.patches?.some((patch:StatePatch)=>patch.section==='delivered')&&!interrupted){interrupted=true;return Promise.reject(Error('Generated ACK persistence interruption'));}
  return (originalRun as any)(input,...rest);
 }) as typeof sourceWork.run;
 await assert.rejects(engine.flush(source,request),/persistence interruption/);
 assert.equal(engine.status().pending,100);assert.equal(node.files.list({limit:200}).items.length,99);
 sourceWork.run=originalRun;engine=new SourceSync(path);await engine.initialize();await engine.flush(source,request);
 assert.equal(engine.status().pending,0);assert.equal(engine.status().blocked,1);assert.equal(engine.status().failures[0].externalId,'file-37');
 await engine.stage(scan(Array.from({length:100},(_,i)=>file(100+i))),false);await engine.flush(source,request);
 const noteId=randomUUID();await request('/api/notes',{id:noteId,deviceId:'generated-mac',deviceName:'Generated Mac',platform:'macos',capturedAt:new Date().toISOString(),text:'Generated note after one quarantined file'},'POST');
 assert.equal(node.files.list({limit:200}).items.length,199);assert.equal(node.store.list({limit:1}).totalCount,200);
 engine=new SourceSync(path);await engine.initialize();assert.equal(engine.status().blocked,1);assert.equal(engine.status().pending,0);
 const http={acceptedFiles:199,blockedFiles:1,followingNotes:1,batches,ackPersistenceRestart:true,requests:latencies.length,p95Ms:latencies.sort((a,b)=>a-b)[Math.ceil(latencies.length*.95)-1],injectedRttMs:rttMs,timing:'request through parsed response, plus configured round-trip delay',transport:'actual loopback HTTP; controlled delay is not a lossy WAN simulation'};

 const catalogPath=join(directory,'large-catalog.json'),count=100000;
 sourceState(catalogPath,[{section:'state',key:'version',value:2},{section:'state',key:'checkpoint',value:{version:1,root:'/generated',scanNumber:1,scanStartedAt:'2026-09-01T00:00:00Z',initialized:true,inProgress:true,pendingDirectories:[],catalog:{}}}]);
 for(let start=0;start<count;start+=1000){const patches:StatePatch[]=[];for(let n=start;n<start+1000;n++){const item={externalId:'catalog-'+n,title:'Generated '+n,text:'',kind:'message',layer:'snapshot'};const key=sourceHash(item.externalId);patches.push({section:'known',key,value:{contentHash:'prior',revision:'r1',item}},{section:'delivered',key,value:'r1'},{section:'catalog',key:item.externalId,value:{relativePath:item.externalId,fileId:String(n),birthtimeMs:0,size:1,mtimeMs:1,ctimeMs:1,quickHash:'old',lastSeenScan:1,syncState:'synced'}});}sourceState(catalogPath,patches);}
 const large=new SourceSync(catalogPath);await large.initialize();
 // Detect accidental full-map traversals on the foreground path, beyond timing noise.
 const internal=(large as any).data;for(const name of ['known','delivered'])internal[name]=new Proxy(internal[name],{ownKeys(){throw Error('Foreground full catalog traversal: '+name);}});
 internal.checkpoint.catalog=new Proxy(internal.checkpoint.catalog,{ownKeys(){throw Error('Foreground full checkpoint traversal');}});
 const workBytes:number[]=[],patchCounts:number[]=[],durations:number[]=[];
 sourceWork.run=((input:any,...rest:any[])=>{if(input.kind==='source-state'){workBytes.push(Buffer.byteLength(JSON.stringify(input)));patchCounts.push(input.patches?.length??0);}return (originalRun as any)(input,...rest);}) as typeof sourceWork.run;
 const metadataSource={...source,id:'large-generated',kind:'coding-agent' as const,retention:'snapshot' as const};
 const localRequest:SourceRequest=async(path,body)=>path==='/api/sources'?metadataSource:{id:'b67c1b84-f2cd-4e59-bf67-215545a882dc',sourceId:metadataSource.id,externalId:(body as any).externalId,revision:(body as any).revision,duplicate:false};
 for(let revision=0;revision<7;revision++){const began=performance.now();await large.stage(scan([{externalId:'catalog-50',title:'Generated 50',text:'Generated revision '+revision,kind:'message',layer:'snapshot'}]),false);await large.flush(metadataSource,localRequest);durations.push(performance.now()-began);}
 const checkpointStart=performance.now(),catalogDraft=new DirectoryCatalog('/generated',large.fileCheckpoint(),undefined,true);
 catalogDraft.observe({path:'/generated/catalog-50',relativePath:'catalog-50',fileId:'50',birthtimeMs:0,size:2,mtimeMs:2,ctimeMs:2,quickHash:'changed'});
 await large.stage({...scan([]),checkpoint:catalogDraft.checkpoint(true),catalogChanges:catalogDraft.catalogChanges()},false);const checkpointMs=performance.now()-checkpointStart;
 assert.equal(large.fileCheckpoint()!.catalog['catalog-50'].size,2);
 assert.equal(large.status().pending,0);assert.ok(Math.max(...workBytes)<4096);assert.ok(Math.max(...patchCounts)<10);
 const ordered=[...durations].sort((a,b)=>a-b),catalog={existingItems:count,changedItemsPerRound:1,rounds:durations.length,medianStageAckMs:ordered[Math.floor(ordered.length/2)],maxStageAckMs:Math.max(...durations),incrementalCheckpointMs:checkpointMs,maxWorkerPayloadBytes:Math.max(...workBytes),maxPatchesPerTransaction:Math.max(...patchCounts),foregroundCatalogEnumerations:0};
 const result={ok:true,personalData:false,liveModelCalls:0,http,catalog};console.log(JSON.stringify(result,null,2));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
}finally{sourceWork.run=originalRun;await sourceWork.close();await node.app.close();await rm(directory,{recursive:true,force:true});}
