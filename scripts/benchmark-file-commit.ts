/** Generated originals only. Real HTTP requests continue during final commit. */
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {FILE_PART_BYTES} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
const directory=await mkdtemp(join(tmpdir(),'mote-commit-benchmark-')),token=randomBytes(32).toString('hex');
const config={dataDir:directory,dataKey:undefined,token,tokenPath:'fixture',profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:3*1024**3,maxExportBytes:16*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent' as const};
const node=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('Fixture must not invoke model');},close:async()=>{}}});
const results:unknown[]=[];
try{
 await node.app.listen({host:'127.0.0.1',port:0});const base=node.app.listeningOrigin;
 const request=async(path:string,body?:unknown,credential=token)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});assert.ok(response.ok,`${path}: ${response.status} ${await (response.ok?Promise.resolve(''):response.text())}`);return response.json();};
 await request('/api/sources',{id:'generated-commit',name:'Generated commit load',kind:'local-files',deviceId:'generated-commit',platform:'android',retention:'archive'});
 for(const sizeMiB of [64,100,512]){
  const size=sizeMiB*1024*1024,part=Buffer.alloc(FILE_PART_BYTES,sizeMiB%251),digest=createHash('sha256');for(let i=0;i<size/part.length;i++)digest.update(part);const hash=digest.digest('hex');
  for(const duplicate of [false,true]){
   const browser=sizeMiB===64,route=browser?'/api/import-uploads':'/api/file-sync/v1/uploads';
   const {invitation}=node.connections.invite({label:'Generated upload probe',serverUrl:base,deviceId:'generated-commit'});const uploadToken=(await node.connections.redeem({code:invitation.code,deviceId:'generated-commit',deviceName:'Generated commit load',platform:'android'})).token;
   const manifest={sourceId:'generated-commit',previousRevision:null,item:{externalId:`generated-${sizeMiB}-${duplicate}.bin`,revision:'1',observedAt:new Date().toISOString(),title:`Generated ${sizeMiB} MiB`,kind:'file',layer:'original',mimeType:'application/octet-stream'},relativePath:`generated-${sizeMiB}.bin`,sizeBytes:size,sha256:hash};
   const credential=browser?token:uploadToken,session=await request(route,browser?{id:randomUUID(),name:'generated-64.bin',sizeBytes:size,mimeType:'application/octet-stream'}:manifest,credential) as {uploadId?:string;id?:string},uploadId=session.uploadId??session.id!;
   for(let index=0;index<size/part.length;index++){const response=await fetch(base+`${route}/${uploadId}/parts/${index}`,{method:'PUT',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/octet-stream'},body:part});assert.ok(response.ok,await response.text());}
   const latencies:Record<string,number[]>={health:[],files:[],ingest:[]};let finished=false;
   const loop=monitorEventLoopDelay({resolution:10});loop.enable();
   const probe=async(kind:string)=>{const started=performance.now();if(kind==='health')await request('/api/health');else if(kind==='files')await request('/api/files?limit=10');else await request('/api/notes',{id:randomUUID(),deviceId:'generated-probes',deviceName:'Generated probes',platform:'import',client:'web',capturedAt:new Date().toISOString(),text:'Generated note arriving during original commit'});latencies[kind].push(performance.now()-started);};
   const probing=(async()=>{while(!finished){await Promise.all(Object.keys(latencies).map(probe));await new Promise(resolve=>setTimeout(resolve,250));}})();
   const started=performance.now();let ack:any,commitMs=0;
   try{ack=await request(`${route}/${uploadId}/commit`,{},credential);commitMs=performance.now()-started;}finally{finished=true;await probing;}
   loop.disable();assert.equal(browser?ack.hash:ack.sha256,hash);assert.equal(ack.sizeBytes,size);
   const summarize=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,p95Ms:sorted[Math.floor((sorted.length-1)*.95)],maxMs:sorted.at(-1)};};
   results.push({protocol:browser?'browser-import':'file-sync',sizeMiB,duplicate,commitMs,eventLoopMaxMs:loop.max/1e6,probes:Object.fromEntries(Object.entries(latencies).map(([name,values])=>[name,summarize(values)]))});
   assert.ok(latencies.health.length>=1,'Concurrent health requests made progress during commit');
   for(const values of Object.values(latencies))assert.ok(Math.max(...values)<1500,'Fixture API latency exceeded 1.5s during final commit');
   assert.equal((await request(`${route}/${uploadId}/commit`,{},credential) as any).id,ack.id,'Lost ACK replay is idempotent');
   console.log(JSON.stringify(results.at(-1)));
  }
 }
 const out=resolve('.mote/review-ui');await mkdir(out,{recursive:true});await writeFile(join(out,'file-commit.json'),JSON.stringify({generatedOnly:true,transport:'real loopback HTTP',rttInjectionMs:0,writePolicy:'plaintext',limits:{apiMaxMs:1500},probeIntervalMs:250,uploadCredentials:'fresh scoped generated device credential per case',results},null,2));
}finally{await node.app.close();await rm(directory,{recursive:true,force:true});}
