import assert from 'node:assert/strict';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import type {buildApp} from '../../src/app.js';

type Central=Awaited<ReturnType<typeof buildApp>>;

/** Real receipt -> Material -> automatic package/claim. Only scheduling is held;
 * originals, selection pins, recipes, frozen ranges and claims are production
 * objects. Each original is too large to share a 12,000-character package. */
export async function seedSourceMemoryBacklog(node:Central,count=540){
 const sourceId='generated-source-backlog',span='Generated recording range. ',text=span.repeat(261);
 node.sources.register({id:sourceId,name:'Generated source backlog',kind:'coding-agent',deviceId:'generated-source-device',platform:'import'});
 node.sourcePipelines.configure(sourceId,{settleSeconds:0});
 const receipts:string[]=[];
 for(let index=0;index<count;index++){
  const receipt=await node.sources.upsert(sourceId,{externalId:'original-'+index,revision:'1',observedAt:'2026-11-01T00:00:00Z',kind:'message',layer:'original',text,document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-backlog',sessionId:'original-'+index,eventId:'event',role:'user',attribution:'human',part:0,parts:1}}});
  receipts.push(receipt.id);
 }
 for(let attempt=0;attempt<100;attempt++){
  await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);
  if(Number(node.store.db.prepare('SELECT count(*) n FROM material_memory_requests WHERE auto_authorized=1').get()!.n)===count)break;
  await yieldTurn();
 }
 assert.equal(Number(node.store.db.prepare('SELECT count(*) n FROM material_memory_requests WHERE auto_authorized=1').get()!.n),count,'every real source receipt must reach its durable Material queue');
 const pipeline=node.memoryPipeline;
 const runner={
  create:(input:Parameters<typeof pipeline.create>[0])=>pipeline.create({...input,evidenceRanges:input.evidenceIds.flatMap(id=>Array.from({length:261},(_,index)=>({id,offset:index*span.length,length:span.length})))}),
  state:(id:string)=>pipeline.state(id),cancel:(id:string)=>pipeline.cancel(id),run:async()=>{},
 };
 while(Number(node.store.db.prepare('SELECT count(*) n FROM material_memory_requests WHERE auto_authorized=1 AND job_id IS NULL').get()!.n)){
  assert.ok(await node.sourcePipelines.drainMemory(runner,true)>0,'the source queue must claim each independent package');await yieldTurn();
 }
 const rows=node.store.db.prepare('SELECT material_id,scope,job_id FROM material_memory_requests ORDER BY material_id,scope').all();
 assert.equal(rows.length,count);assert.equal(new Set(rows.map(row=>String(row.job_id))).size,count);
 assert.equal(Number(node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE authorized=1 AND revoked_at IS NULL AND job_id IS NOT NULL').get()!.n),count);
 assert.equal(Number(node.store.db.prepare('SELECT count(*) n FROM source_pipeline_bindings WHERE source_id=?').get(sourceId)!.n),1);
 return {ids:rows.map(row=>String(row.job_id)),receipts,text,sourceId};
}
