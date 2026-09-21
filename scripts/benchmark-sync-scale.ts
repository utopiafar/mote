/** Generated metadata only. Exercises the actual desktop outbox and central manifest protocol in-process. */
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../apps/server/src/store.js';
import {SourceStore} from '../apps/server/src/sources.js';
import {FileStore} from '../apps/server/src/files.js';
import {SourceSync,sourceHash} from '../apps/desktop/src/source-sync.js';
import {sourceWork} from '../apps/desktop/src/background.js';
import type {SourceDefinition,ScannedItem,SourceRequest} from '../apps/desktop/src/source-types.js';
const count=Number(process.env.MOTE_FIXTURE_COUNT??100000),directory=await mkdtemp(join(tmpdir(),'mote-sync-scale-'));
const store=new Store(join(directory,'central')),sources=new SourceStore(store),files=new FileStore(store,sources);
const source:SourceDefinition={id:'scale-fixture',name:'Generated shadow directory',deviceId:'synthetic',platform:'macos',kind:'local-files',retention:'reference',enabled:true};
const samples:number[]=[],latencies:number[]=[];let requests=0;
const request:SourceRequest=async(path,body)=>{const start=performance.now();requests++;try{
 if(path==='/api/sources')return sources.register(body);
 if(path==='/api/file-sync/v1/capabilities')return files.capabilities();
 if(path==='/api/file-sync/v1/manifests')return await files.manifestBatch(body,()=>{});
 throw Error('Unexpected transport operation '+path);
}finally{latencies.push(performance.now()-start);}};
const start=performance.now();
try{
 let sync=new SourceSync(join(directory,'client.json'));await sync.initialize();
 for(let begin=0;begin<count;begin+=1000){
  const items:ScannedItem[]=Array.from({length:Math.min(1000,count-begin)},(_,offset)=>{const index=begin+offset;return {externalId:'file-'+index,title:'Generated '+index+'.txt',text:'',kind:'file',layer:'reference',document:{fileIndex:{version:1,fileId:'file-'+index,contentVersion:sourceHash('fixture-'+index),mode:'catalog',coverage:'none',parser:'none',status:'ready',totalCharacters:0,offset:0,length:0,allowRead:false}},metadata:{version:1,file:{sizeBytes:200000}},uri:'file:///synthetic/'+index+'.txt'};});
  await sync.stage({items,seen:items.map(x=>x.externalId),complete:false,skipped:0},false);await sync.flush(source,request);
  const at=performance.now();store.list({limit:20,includeTotal:false});samples.push(performance.now()-at);
  if((begin+1000)%10000===0)console.log(JSON.stringify({processed:begin+items.length,elapsedMs:performance.now()-start}));
 }
 assert.equal(sync.status().pending,0);assert.equal(sync.status().items,count);assert.equal(store.list({limit:1}).totalCount,count);
 sync=new SourceSync(join(directory,'client.json'));await sync.initialize();assert.equal(sync.status().pending,0);assert.equal(sync.status().items,count);
 for(let i=samples.length;i<200;i++){const at=performance.now();store.list({limit:20,includeTotal:false});samples.push(performance.now()-at);}
 const p95=(values:number[])=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
 const result={count,durationMs:performance.now()-start,requests,ackP95Ms:p95(latencies),listP95Ms:p95(samples),listSamples:samples.length,modelCalls:0,personalData:false,transport:'in-process desktop SourceSync to central FileStore; excludes network RTT'};
 console.log(JSON.stringify(result));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
}finally{await sourceWork.close();store.close();await rm(directory,{recursive:true,force:true});}
