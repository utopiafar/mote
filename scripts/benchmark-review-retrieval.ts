/** Generated 45-day archive; real loopback HTTP remains active during exact vector scans. */
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';

const directory=await mkdtemp(join(tmpdir(),'mote-review-retrieval-'));
const token='generated-retrieval-benchmark-token';let dimensions=768;
const provider=createServer(async(req,res)=>{for await(const _chunk of req){};res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)}]}));});
await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
const config:Config={dataDir:directory,token,tokenPath:'generated',dataKey:undefined,host:'127.0.0.1',port:0,maxStorageBytes:2*1024**3,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'generated',embeddingBaseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}`,embeddingApiKey:''};
const fixture=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No live model in this benchmark');},close:async()=>{}}});
const {store,app,indexer}=fixture,rows=9000,reports:unknown[]=[];
const record=(n:number)=>({id:randomUUID(),deviceId:'generated-persona',deviceName:'Generated Persona',platform:'import',source:'note',durationMs:0,capturedAt:new Date(Date.parse('2026-07-01')+Math.floor(n/200)*86400000+n%200*60000).toISOString(),ocrText:`Generated record ${n}; retrieval responsiveness fixture.`});
try{
 for(let start=0;start<rows;start+=100)await store.ingestBatch(Array.from({length:100},(_,i)=>record(start+i)));
 const base=await app.listen({host:'127.0.0.1',port:0}),headers={authorization:'Bearer '+token,'content-type':'application/json'};
 for(const size of [768,1536]){
  dimensions=size;
  const vector=JSON.stringify(Array.from({length:size},(_,i)=>Number(((i%13+1)/14).toFixed(5))));
  store.db.prepare("UPDATE captures SET embedding=?,embedding_model='generated',index_status='indexed'").run(vector);
  let done=false;const latencies:{route:string;ms:number}[]=[],start=performance.now();
  const search=indexer.search({query:`generated-dimension-${size}`,limit:10}).finally(()=>{done=true;});
  const probe=async()=>{do{for(const path of ['/api/health','/api/captures?limit=10']){const begin=performance.now(),response=await fetch(base+path,{headers});assert.equal(response.status,200);await response.arrayBuffer();latencies.push({route:path,ms:performance.now()-begin});}const begin=performance.now(),response=await fetch(base+'/api/captures',{method:'POST',headers,body:JSON.stringify({...record(8999),ocrText:'Generated concurrent upload'})});assert.equal(response.status,201);await response.arrayBuffer();latencies.push({route:'POST /api/captures',ms:performance.now()-begin});await new Promise(r=>setTimeout(r,10));}while(!done);};
  const [matches]=await Promise.all([search,probe()]);const elapsedMs=performance.now()-start;
  const sorted=latencies.map(v=>v.ms).sort((a,b)=>a-b),p95Ms=sorted[Math.ceil(sorted.length*.95)-1],maxMs=sorted.at(-1)!;
  assert.ok(matches.length>0);assert.ok(p95Ms<500,'local API p95 exceeded 500ms during vector work');assert.ok(elapsedMs<2500,'query did not respect its deadline');
  reports.push({dimensions:size,rows,elapsedMs,retrieval:matches.retrieval,http:{samples:latencies.length,p95Ms,maxMs},latencies});
 }
 const report={generated:true,personalData:false,model:'deterministic embedding fixture',transport:'real loopback HTTP; no injected WAN RTT',days:45,recordsPerDay:200,records:rows,thresholds:{httpP95Ms:500,queryMs:2500},reports};
 const output=process.env.MOTE_REVIEW_RETRIEVAL_OUTPUT??join(tmpdir(),'mote-review-retrieval.json');await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
