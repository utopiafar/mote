/** Generated data only. Real archive, desktop outbox, retrieval and shared execution
 * run concurrently. Model work is a bounded fixture; live-model quality is separate. */
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance,monitorEventLoopDelay,PerformanceObserver,constants} from 'node:perf_hooks';
import {setTimeout as delay,setImmediate as yieldTurn} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Store} from '../apps/server/src/store.js';
import {SourceStore} from '../apps/server/src/sources.js';
import {FileStore} from '../apps/server/src/files.js';
import {ContextQuery} from '../apps/server/src/context-query.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionHandler} from '../apps/server/src/execution-engine.js';
import {QueryRuns} from '../apps/server/src/query-runs.js';
import {Operations} from '../apps/server/src/operations.js';
import {SourceSync,sourceHash} from '../apps/desktop/src/source-sync.js';
import {sourceWork} from '../apps/desktop/src/background.js';
import type {ScannedItem,SourceDefinition,SourceRequest} from '../apps/desktop/src/source-types.js';

if(process.argv[2]==='--crash-child'){
 const keepAlive=setInterval(()=>{},1000),root=process.argv[3],s=new Store(root),e=new ExecutionEngine(s);
 e.register({kind:'fixture.crash',pool:'fixture-crash',concurrency:()=>1,validate:()=>true,execute:async()=>{await writeFile(join(root,'child-started'),'generated');await new Promise(()=>{});},commit:()=>{throw Error('Killed child cannot commit');}});
 e.enqueue('fixture:crash','fixture.crash',{}, {id:'fixture-crash'});await e.tick();await new Promise(()=>{});
}
const count=Number(process.env.MOTE_MIXED_FILES??100000),minimumMs=Number(process.env.MOTE_MIXED_MS??120000),captures=Number(process.env.MOTE_MIXED_CAPTURES??400),steadyMs=Number(process.env.MOTE_MIXED_STEADY_MS??0);
assert.ok(Number.isFinite(steadyMs)&&steadyMs>=0&&steadyMs<=30*60000,'Steady window must be bounded to 30 minutes');
const root=await mkdtemp(join(tmpdir(),'mote-mixed-')),directory=join(root,'central'),store=new Store(directory,{maxStorageBytes:4*1024**3}),sources=new SourceStore(store),files=new FileStore(store,sources),engine=new ExecutionEngine(store),runs=new QueryRuns(store,{executor:engine,concurrency:()=>2}),operations=new Operations(store),context=new ContextQuery(store,sources,files);
const histogram=monitorEventLoopDelay({resolution:20});histogram.enable();const started=performance.now();
const source:SourceDefinition={id:'mixed-catalog',name:'Generated mixed directory',kind:'local-files',deviceId:'catalog-device',platform:'macos',retention:'reference',enabled:true};
let sync=new SourceSync(join(root,'outbox.json')),finished=false,stop=false,requests=0,catalogBatches=0,queryCalls=0,workerCalls=0,queuePeak=0,oldestQueueMs=0,lostAck=false,offline=false,limited=false;
let steadyStarted:number|undefined,steadyMode=false;
const ids:string[]=[],deleted=new Set<string>(),jobs:string[]=[],times={query:[] as number[],browse:[] as number[],capture:[] as number[],ack:[] as number[]},resources:{atMs:number;rss:number;heap:number;heapTotal:number;external:number;arrayBuffers:number;queued:number;oldestMs:number}[]=[];
const steadyTimes={query:[] as number[],browse:[] as number[],background:[] as number[]},gc:{atMs:number;durationMs:number;major:boolean}[]=[];
const gcObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(gc.length<20000)gc.push({atMs:entry.startTime-started,durationMs:entry.duration,major:((entry as unknown as {detail:{kind:number}}).detail.kind&constants.NODE_PERFORMANCE_GC_MAJOR)!==0});});gcObserver.observe({entryTypes:['gc']});
store.db.exec('CREATE TABLE mixed_results(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,hash TEXT NOT NULL)');
const handler:ExecutionHandler={kind:'fixture.background',pool:'fixture-background',concurrency:()=>2,validate:step=>Boolean(store.evidence([String(step.input.id)]).length),execute:async step=>{workerCalls++;if(!steadyMode&&Number(step.input.ordinal)%31===0&&step.attempts===1)throw new ExecutionFailure('transient','rate_limited',20);if(step.input.deleteLate){setTimeout(()=>{store.delete(String(step.input.id));deleted.add(String(step.input.id));},5);}await delay(40);return createHash('sha256').update(store.evidence([String(step.input.id)])[0]?.ocrText??'deleted').digest('hex');},commit:(step,result)=>{store.db.prepare(steadyMode?'INSERT INTO mixed_results VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash':'INSERT INTO mixed_results VALUES(?,?,?)').run(step.id,String(step.input.id),String(result));}};
engine.register(handler);
const request:SourceRequest=async(path,body)=>{const at=performance.now();requests++;try{
 if(path==='/api/sources')return sources.register(body);
 if(path==='/api/file-sync/v1/capabilities')return files.capabilities();
 if(path==='/api/file-sync/v1/manifests'){
  if(!offline&&catalogBatches>=1){offline=true;throw Object.assign(new Error('Generated offline'),{code:'ECONNRESET'});}
  if(!limited&&catalogBatches>=2){limited=true;throw Object.assign(new Error('Generated limit'),{statusCode:429});}
  const result=await files.manifestBatch(body,()=>{});catalogBatches++;
  if(!lostAck){lostAck=true;throw Object.assign(new Error('Generated lost response after central commit'),{code:'ECONNRESET'});}
  return result;
 }
 throw Error('Unexpected generated transport '+path);
}finally{times.ack.push(performance.now()-at);}};
async function retryFlush(){for(let attempt=0;attempt<10;attempt++){try{await sync.flush(source,request);return;}catch(error){if(!['ECONNRESET'].includes(String((error as any).code))&&(error as any).statusCode!==429)throw error;await delay(10);}}throw Error('Generated recovery failed');}
const pump=setInterval(()=>void engine.tick().catch(error=>{console.error(error);stop=true;}),10);
const sample=setInterval(()=>{const q=store.db.prepare("SELECT count(*) n,min(created_at) oldest FROM execution_steps WHERE state='waiting'").get()!,queued=Number(q.n),oldest=q.oldest===null?0:Math.max(0,Date.now()-Number(q.oldest));queuePeak=Math.max(queuePeak,queued);oldestQueueMs=Math.max(oldestQueueMs,oldest);const m=process.memoryUsage();resources.push({atMs:performance.now()-started,rss:m.rss,heap:m.heapUsed,heapTotal:m.heapTotal,external:m.external,arrayBuffers:m.arrayBuffers,queued,oldestMs:oldest});},1000);
try{
 await sync.initialize();
 const catalog=(async()=>{for(let first=0;first<count;first+=500){const items:ScannedItem[]=Array.from({length:Math.min(500,count-first)},(_,offset)=>{const i=first+offset;return {externalId:'file-'+i,title:'Generated '+i+'.txt',text:'',kind:'file',layer:'reference',uri:'file:///synthetic/'+i+'.txt',document:{fileIndex:{version:1,fileId:'file-'+i,contentVersion:sourceHash('mixed-'+i),mode:'catalog',coverage:'none',parser:'none',status:'ready',totalCharacters:0,offset:0,length:0,allowRead:false}},metadata:{version:1,file:{sizeBytes:1000}}};});await sync.stage({items,seen:items.map(i=>i.externalId),complete:false,skipped:0},false);await retryFlush();if(first%10000===0)console.log(JSON.stringify({stage:'catalog',processed:first+items.length,queries:queryCalls,workers:workerCalls,captures:ids.length}));await yieldTurn();}finished=true;})();
 const capture=(async()=>{for(let i=0;i<captures;i++){
  const id=randomUUID(),input={id,deviceId:'capture-device-'+i%2,deviceName:'Generated device',platform:'import',source:'note',appId:'fixture',appName:'Generated fixture',capturedAt:new Date(Date.UTC(2025,0,1+i)).toISOString(),durationMs:0,ocrText:`MIXED_FACT_${i} generated long-period record ${i}; device ${i%2}.`,privacy:{excluded:false,redacted:false,mode:'none'}};
  const at=performance.now();
  if(i===3){const full=new Store(directory,{maxStorageBytes:1});try{await assert.rejects(full.ingest(input),e=>(e as any).statusCode===507);}finally{full.close();}assert.equal(store.evidence([id]).length,0);}
  await store.ingest(input);ids.push(id);times.capture.push(performance.now()-at);
  jobs.push(engine.enqueue('capture:'+id,'fixture.background',{id,ordinal:i,deleteLate:i===5}));
  await delay(Math.max(5,Math.floor(minimumMs/Math.max(captures,1))));
 }})();
 const browsing=(async()=>{while(!stop&&(!finished||ids.length<captures||performance.now()-started<minimumMs)){
  const at=performance.now(),page=store.list({deviceId:'catalog-device',limit:20,includeTotal:false});assert.ok(page.items.every(r=>r.deviceId==='catalog-device'));operations.page({limit:20});times.browse.push(performance.now()-at);
  if(ids.length){const queryAt=performance.now();await runs.perform(randomUUID(),{fixture:true},async()=>{await delay(15);const result=context.search({query:'MIXED_FACT',deviceId:'capture-device-0',limit:20,maxCharacters:6000});assert.ok(result.items.every(item=>item.origin.deviceId==='capture-device-0'));queryCalls++;return {conversationId:'fixture-conversation',turnId:randomUUID()};},{timeoutMs:5000});times.query.push(performance.now()-queryAt);}await delay(150);
 }})();
 const crash=(async()=>{while(ids.length<8)await delay(20);const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--crash-child',directory],{stdio:'inherit'});const exited=new Promise(resolve=>child.once('exit',resolve));try{for(let i=0;;i++){try{await access(join(directory,'child-started'));break;}catch{if(i>250)throw Error('Crash fixture did not start');await delay(20);}}console.log(JSON.stringify({stage:'crash-started',captures:ids.length}));child.kill('SIGKILL');await exited;console.log(JSON.stringify({stage:'crash-killed'}));store.db.prepare('UPDATE execution_steps SET lease_until=? WHERE id=?').run(Date.now()-1,'fixture-crash');engine.register({kind:'fixture.crash',pool:'fixture-crash',concurrency:()=>1,validate:()=>true,execute:async()=> 'recovered',commit:(step,result)=>{store.db.prepare('INSERT INTO mixed_results VALUES(?,?,?)').run(step.id,'generated-crash',String(result));}});await engine.drain(['fixture-crash']);assert.equal(engine.get('fixture-crash')?.state,'succeeded');}finally{child.kill('SIGKILL');}})();
 await Promise.all([catalog,capture,browsing,crash]);console.log(JSON.stringify({stage:'producers-finished'}));assert.equal(stop,false);await engine.drain(jobs);
 assert.ok(lostAck&&offline&&limited);assert.equal(sync.status().pending,0);assert.equal(sync.status().items,count);
 sync=new SourceSync(join(root,'outbox.json'));await sync.initialize();assert.equal(sync.status().pending,0);assert.equal(sync.status().items,count);
 assert.equal(store.list({deviceId:'catalog-device',limit:1}).totalCount,count);
 const found=new Set<string>();let cursor:string|undefined;do{const page=store.list({deviceId:'catalog-device',limit:100,cursor,includeTotal:false});for(const item of page.items){assert.equal(found.has(item.id),false);found.add(item.id);}cursor=page.nextCursor??undefined;}while(cursor);assert.equal(found.size,count);
 for(const id of deleted){assert.equal(store.evidence([id]).length,0);assert.equal(store.db.prepare('SELECT 1 FROM mixed_results WHERE source_id=?').get(id),undefined);}
 assert.equal(Number(store.db.prepare('SELECT count(*) n FROM mixed_results').get()!.n),captures-deleted.size+1);
 assert.equal(Number(store.db.prepare("SELECT count(*) n FROM execution_steps WHERE state IN ('waiting','running')").get()!.n),0);
 let steadyCounts:{queries:number;workers:number;fixedCaptures:number;fixedCatalog:number;queryReceiptsBefore:number;queryReceiptsAfter:number}|undefined;
 if(steadyMs){
  const beforeQueries=queryCalls,beforeWorkers=workerCalls,fixedCaptures=store.stats().captures,queryReceiptsBefore=Number(store.db.prepare('SELECT count(*) n FROM query_runs').get()!.n),available=jobs.filter(id=>engine.get(id)?.state==='succeeded');assert.ok(available.length);
  steadyMode=true;steadyStarted=performance.now()-started;const until=performance.now()+steadyMs;
  console.log(JSON.stringify({stage:'steady-start',durationMs:steadyMs,catalog:count,captures:fixedCaptures,rate:'one query/browse loop and one existing background step per ~150ms; no new originals; natural GC only'}));
  const browse=(async()=>{while(performance.now()<until&&!stop){let at=performance.now();const page=store.list({deviceId:'catalog-device',limit:20,includeTotal:false});assert.ok(page.items.every(r=>r.deviceId==='catalog-device'));operations.page({limit:20});steadyTimes.browse.push(performance.now()-at);at=performance.now();await runs.perform(randomUUID(),{fixture:true,steady:true},async()=>{await delay(15);const result=context.search({query:'MIXED_FACT',deviceId:'capture-device-0',limit:20,maxCharacters:6000});assert.ok(result.items.every(item=>item.origin.deviceId==='capture-device-0'));queryCalls++;return {conversationId:'fixture-conversation',turnId:randomUUID()};},{timeoutMs:5000});steadyTimes.query.push(performance.now()-at);await delay(150);}})();
  const background=(async()=>{let n=0;while(performance.now()<until&&!stop){const id=available[n++%available.length],at=performance.now();engine.retry(id);await engine.drain([id]);assert.equal(engine.get(id)?.state,'succeeded');steadyTimes.background.push(performance.now()-at);await delay(150);}})();
  const progress=setInterval(()=>{const sample=resources.at(-1);console.log(JSON.stringify({stage:'steady-progress',elapsedMs:performance.now()-started-steadyStarted!,queries:queryCalls-beforeQueries,workers:workerCalls-beforeWorkers,...sample}));},60000);
  try{await Promise.all([browse,background]);}finally{clearInterval(progress);}
  assert.equal(stop,false);await engine.drain(jobs);assert.equal(store.stats().captures,fixedCaptures);assert.equal(store.list({deviceId:'catalog-device',limit:1}).totalCount,count);assert.equal(Number(store.db.prepare('SELECT count(*) n FROM mixed_results').get()!.n),captures-deleted.size+1);assert.equal(Number(store.db.prepare("SELECT count(*) n FROM execution_steps WHERE state IN ('waiting','running')").get()!.n),0);
  steadyCounts={queries:queryCalls-beforeQueries,workers:workerCalls-beforeWorkers,fixedCaptures,fixedCatalog:count,queryReceiptsBefore,queryReceiptsAfter:Number(store.db.prepare('SELECT count(*) n FROM query_runs').get()!.n)};
 }
 const p95=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1]??0;
 const steadyResources=resources.filter(s=>steadyStarted!==undefined&&s.atMs>=steadyStarted),minutes=Array.from({length:Math.ceil(steadyMs/60000)},(_,minute)=>{const samples=steadyResources.filter(s=>Math.floor((s.atMs-steadyStarted!)/60000)===minute),collections=gc.filter(s=>s.atMs>=steadyStarted!+minute*60000&&s.atMs<steadyStarted!+(minute+1)*60000);return {minute,samples:samples.length,rssMin:Math.min(...samples.map(s=>s.rss)),rssMax:Math.max(...samples.map(s=>s.rss)),heapMin:Math.min(...samples.map(s=>s.heap)),heapMax:Math.max(...samples.map(s=>s.heap)),queueMax:Math.max(0,...samples.map(s=>s.queued)),oldestMaxMs:Math.max(0,...samples.map(s=>s.oldestMs)),naturalGc:collections.length,naturalMajorGc:collections.filter(s=>s.major).length};}).filter(m=>m.samples);
 const slope=(values:number[])=>{const n=values.length,mean=values.reduce((a,b)=>a+b,0)/n,x=(n-1)/2;return values.reduce((v,y,i)=>v+(i-x)*(y-mean),0)/values.reduce((v,_y,i)=>v+(i-x)**2,0)/1024**2;},tail=minutes.filter(m=>m.minute>=2).slice(-5),rssSlope=tail.length>=5?slope(tail.map(m=>m.rssMin)):null,heapSlope=tail.length>=5?slope(tail.map(m=>m.heapMin)):null;
 const steady=steadyMs?{durationMs:steadyMs,startedAtMs:steadyStarted,counts:steadyCounts,forcedGc:false,rawSamples:steadyResources.length,minutes,latencyP95Ms:Object.fromEntries(Object.entries(steadyTimes).map(([key,value])=>[key,p95(value)])),assessment:{scope:'A fixed generated data set under this offered load; not a long-term leak proof or live-model throughput result.',criteria:'At least 10 post-warmup minutes; final five one-minute low-water marks slope <=4 MiB/min RSS and <=2 MiB/min heap; queue <=8 and oldest <=5s; all work drains.',rssLowWaterSlopeMiBPerMinute:rssSlope,heapLowWaterSlopeMiBPerMinute:heapSlope,observedPlateau:minutes.filter(m=>m.minute>=2&&m.samples>=50).length>=10&&rssSlope!==null&&rssSlope<=4&&heapSlope!==null&&heapSlope<=2&&minutes.every(m=>m.queueMax<=8&&m.oldestMaxMs<=5000)}}:undefined;
 const report={generatedAt:new Date().toISOString(),fixtureOnly:true,liveModelCalls:0,personalDataUsed:false,transport:'actual desktop SourceSync to central FileStore in process; query runtime with generated model work',counts:{catalog:count,captures,days:captures,queries:queryCalls,workerCalls,requests,deleted:deleted.size},durationMs:performance.now()-started,latencyP95Ms:Object.fromEntries(Object.entries(times).map(([key,value])=>[key,p95(value)])),eventLoopP95Ms:histogram.percentile(95)/1e6,queue:{peak:queuePeak,oldestMs:oldestQueueMs,remaining:0},resources,steady,faults:{lostAck:true,offline:true,rateLimit:true,storageQuota:true,processSigkill:true,leaseExpiry:'injected expiry after confirmed SIGKILL',lateDelete:true},checks:{allCatalogPages:true,allAcksRecovered:true,scopesIsolated:true,noLateResurrection:true,exactlyOnceInitialCommit:true}};
 const output=process.env.MOTE_MIXED_OUTPUT??'/tmp/mote-mixed-load.json';await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:true,report:output,...report.counts,latencyP95Ms:report.latencyP95Ms,queue:report.queue}));
}catch(error){console.error(error);throw error;}finally{stop=true;clearInterval(pump);clearInterval(sample);histogram.disable();gcObserver.disconnect();await engine.close();await runs.close();await sourceWork.close();store.close();await rm(root,{recursive:true,force:true});}
