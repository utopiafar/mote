/** Small generated retention diagnostic. No forced GC and no personal data.
 * Run separate processes before/after a proven fix; this is not an SLA benchmark. */
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {performance,PerformanceObserver,constants} from 'node:perf_hooks';
import {setImmediate as yieldTurn,setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Store} from '../apps/server/src/store.js';
import {ExecutionEngine} from '../apps/server/src/execution-engine.js';
import {QueryRuns} from '../apps/server/src/query-runs.js';

const root=await mkdtemp(join(tmpdir(),'mote-execution-retention-')),store=new Store(root),engine=new ExecutionEngine(store),runs=new QueryRuns(store,{executor:engine});
const iterations=Number(process.env.MOTE_RETENTION_ITERATIONS??10000),pauseMs=Number(process.env.MOTE_RETENTION_PAUSE_MS??0),output=process.env.MOTE_RETENTION_OUTPUT??'/tmp/mote-execution-retention.json';
assert.ok(Number.isSafeInteger(iterations)&&iterations>0&&iterations<=20000);assert.ok(pauseMs>=0&&pauseMs<=1000);
const started=performance.now(),startedAt=new Date().toISOString(),implementation=String((engine as unknown as {execute:unknown}).execute),implementationHash=createHash('sha256').update(implementation).digest('hex'),usesAbortSignalTimeout=implementation.includes('AbortSignal.timeout'),samples:unknown[]=[],collections:{atMs:number;durationMs:number;major:boolean;heap:number;completed:number}[]=[];let completed=0;
const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())collections.push({atMs:entry.startTime-started,durationMs:entry.duration,major:((entry as unknown as {detail:{kind:number}}).detail.kind&constants.NODE_PERFORMANCE_GC_MAJOR)!==0,heap:process.memoryUsage().heapUsed,completed});});observer.observe({entryTypes:['gc']});
const internals=()=>{const e=engine as unknown as {handlers:Map<unknown,unknown>;active:Map<unknown,unknown>;programs:Map<unknown,unknown>},r=(runs as unknown as {execution:{pending:Map<unknown,unknown>;started:Set<unknown>;observed:Set<unknown>}}).execution;return {handlers:e.handlers.size,active:e.active.size,programs:e.programs.size,pending:r.pending.size,started:r.started.size,observed:r.observed.size};};
const sample=()=>{const m=process.memoryUsage();samples.push({atMs:performance.now()-started,completed,rss:m.rss,heap:m.heapUsed,heapTotal:m.heapTotal,external:m.external,counts:internals()});};
try{
 const ids=Array.from({length:4},()=>randomUUID());for(const [n,id] of ids.entries())await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',appId:'fixture',appName:'Generated',capturedAt:new Date(Date.UTC(2025,0,1+n)).toISOString(),durationMs:0,ocrText:'GENERATED_FIXED_RECORD '+n,privacy:{excluded:false,redacted:false,mode:'none'}});
 engine.register({kind:'retention.background',pool:'retention',concurrency:()=>2,validate:step=>store.evidence([String(step.input.id)]).length===1,execute:async step=>{await yieldTurn();return store.evidence([String(step.input.id)])[0].ocrText;},commit:()=>{}});
 const background=ids.map(id=>engine.enqueue('capture:'+id,'retention.background',{id}));await engine.drain(background);sample();
 for(let n=0;n<iterations;n++){
  const id=background[n%background.length];engine.retry(id);
  await Promise.all([engine.drain([id]),runs.perform(randomUUID(),{generated:true},async()=>{await yieldTurn();assert.equal(store.search({query:'GENERATED_FIXED_RECORD',deviceId:'generated'}).length,4);return {conversationId:'generated',turnId:randomUUID()};},{timeoutMs:5000})]);
  completed++;if(completed%250===0){await yieldTurn();sample();}if(pauseMs)await delay(pauseMs);
 }
 await delay(2000);sample();const final=internals();assert.deepEqual(final,{handlers:2,active:0,programs:0,pending:0,started:0,observed:0});assert.equal(store.stats().captures,4);
 const report={generatedAt:new Date().toISOString(),startedAt,implementationHash,usesAbortSignalTimeout,node:process.version,fixtureOnly:true,personalDataUsed:false,forcedGc:false,iterations,backgroundExecutions:iterations+4,durationMs:performance.now()-started,fixedOriginals:4,queryReceipts:Number(store.db.prepare('SELECT count(*) n FROM query_runs').get()!.n),finalCounts:final,samples,naturalGc:collections,scope:'Generated accelerated retention diagnostic; heap at natural GC notification is an observation, not a retained-size proof or production latency benchmark.'};await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:true,output,iterations,durationMs:report.durationMs,naturalMajorGc:collections.filter(c=>c.major).length,finalCounts:final,first:samples[0],last:samples.at(-1)}));
}finally{observer.disconnect();await runs.close();await engine.close();store.close();await rm(root,{recursive:true,force:true});}
