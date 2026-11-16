import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Store} from '../../src/store.js';
import type {SourceStore} from '../../src/sources.js';
import type {MemoryPipeline} from '../../src/memory-pipeline.js';
import type {MemoryInputAuthorization} from '../../src/memory-input-authorization.js';

/** Valid, unactivated persisted receipts with a realistic frozen-range payload.
 * Clone only generated domain rows; the real insert/update triggers maintain
 * their counters. No model work or real profile participates in this fixture. */
export async function seedMemoryControlBacklog({store,sources,pipeline,grants}:{store:Store;sources:SourceStore;pipeline:MemoryPipeline;grants:MemoryInputAuthorization}){
 sources.register({id:'generated',name:'Generated backlog',kind:'custom',deviceId:'generated-device',platform:'import'});
 const text='Generated recording range. '.repeat(261),receipt=await store.ingest({id:randomUUID(),deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-11-01T00:00:00Z',durationMs:0,ocrText:text});
 const evidenceRanges=Array.from({length:261},(_,index)=>({id:receipt.id,offset:index*27,length:27}));
 const template=pipeline.create({evidenceIds:[receipt.id],evidenceRanges});
 const originalJob=JSON.parse(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(template.id)!.json));
 const originalBatches=store.db.prepare('SELECT json FROM memory_batches WHERE job_id=? ORDER BY idx').all(template.id).map(row=>JSON.parse(String(row.json)));
 assert.ok(originalBatches.length>0);
 const ids:string[]=[];
 store.db.exec('BEGIN IMMEDIATE');
 try{
  for(let index=0;index<540;index++){
   const id=index===0?template.id:randomUUID(),inputKey='generated-claim-'+index;ids.push(id);
   grants.receive({sourceId:'generated',inputKey});
   const selected=grants.list('generated',inputKey).filter(grant=>grant.authorized);assert.equal(selected.length,1);
   const scope=selected[0].scope;
   assert.equal(grants.claim('generated',inputKey,id,scope),true);
   const job={...originalJob,id,automaticGrant:{sourceId:'generated',inputKey,scope}};
   if(index===0)store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify(job),id);
   else{
    store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(id,job.createdAt,JSON.stringify(job));
    for(const batch of originalBatches){const batchId=randomUUID();store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run(batchId,id,batch.index,JSON.stringify({...batch,id:batchId}));}
   }
  }
  // Only the generated queue's explicit claims participate in its count.
  store.db.prepare("UPDATE memory_input_authorizations SET revoked_at=1 WHERE input_key NOT LIKE 'generated-claim-%'").run();
  store.db.exec('COMMIT');
 }catch(error){store.db.exec('ROLLBACK');throw error;}
 return {ids,receipt,text,evidenceRanges};
}
