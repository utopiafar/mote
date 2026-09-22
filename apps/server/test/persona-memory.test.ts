import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {personaFixture} from '../../../scripts/fixtures/persona.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';

test('45-day generated Persona preserves late authorship, closes every bounded batch and deduplicates replay',async t=>{
 const fixture=personaFixture(),directory=await mkdtemp(join(tmpdir(),'mote-persona-fixture-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 let pipeline:MemoryPipeline|undefined;
 t.after(async()=>{await pipeline?.close();store.close();await rm(directory,{recursive:true,force:true});});
 for(const sourceId of ['persona-journal','persona-observations'])sources.register({id:sourceId,name:sourceId,kind:'custom',deviceId:'synthetic-persona',platform:'import'});
 const ids:string[]=[],byKey=new Map<string,string>(),started=performance.now();
 for(const record of fixture.records){const saved=await sources.upsert(record.sourceId,record.item);ids.push(saved.id);if(record.key)byKey.set(record.key,saved.id);}
 assert.equal(ids.length,1080);assert.equal(new Set(ids).size,1080);
 assert.equal(store.list({after:fixture.authoredAfter,before:fixture.authoredBefore,limit:1}).totalCount,1080);
 const late=store.evidence([byKey.get('outbox-decision')!])[0];
 assert.equal(late.capturedAt,'2026-09-12T10:00:00.000Z');assert.equal(late.provenance?.document?.recordedAt,'2026-08-05T10:00:00.000Z');
 assert.ok(store.list({after:'2026-08-05T00:00:00Z',before:'2026-08-06T00:00:00Z',limit:100}).items.some(item=>item.id===late.id));
 const seen=new Set<string>();let calls=0;
 pipeline=new MemoryPipeline({store,memories,concurrency:()=>3,configured:()=>true,model:()=> 'fixture-no-semantic-judgment',query:async input=>{calls++;for(const range of input.evidenceRanges){assert.ok(!seen.has(range.id));seen.add(range.id);assert.ok(range.length>0&&range.length<=12000);}return {answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-empty'};}});
 const job=await pipeline.run(pipeline.create({evidenceIds:ids,timeZone:'Asia/Shanghai'}).id);
 assert.equal(job.status,'completed');assert.equal(job.failedBatches,0);assert.equal(job.pendingBatches,0);assert.equal(job.runningBatches,0);assert.equal(seen.size,1080);assert.equal(calls,54);
 assert.equal(pipeline.create({evidenceIds:ids}).totalBatches,0);
 t.diagnostic(JSON.stringify({days:45,records:1080,recordsPerDay:24,batches:calls,elapsedMs:Math.round(performance.now()-started),semanticQualityTested:false,personalDataUsed:false}));
});
