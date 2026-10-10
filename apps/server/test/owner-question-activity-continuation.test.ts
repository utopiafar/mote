import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {Operations} from '../src/operations.js';
import {ActivityProjection} from '../src/activity.js';

for(const scope of ['manual','import'] as const)test(`${scope} owner continuations keep their original Activity goal and record identity across startup`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-owner-activity-')),store=new Store(directory),engine=new ExecutionEngine(store),operations=new Operations(store);let activity=new ActivityProjection(store,operations);t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const at='2026-09-01T00:00:00Z',oldId='00000000-0000-4000-8000-000000000041',newId='00000000-0000-4000-8000-000000000042',material='mat_'+'a'.repeat(64),rootId='generated-original',childId='generated-continuation';
 const root={id:rootId,status:'completed',createdAt:at,updatedAt:at,evidenceIds:[oldId],memoryIds:[],materialInputs:[{materialId:material,fingerprint:'a'.repeat(64),evidenceIds:[oldId],required:['body']}],materialRefs:{[oldId]:'generated-original-ref'},...(scope==='import'?{importJobId:'generated-import'}:{})};
 store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(rootId,at,JSON.stringify(root));
 store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run('generated-original-batch',rootId,0,JSON.stringify({id:'generated-original-batch',index:0,status:'completed',evidenceRanges:[{id:oldId,offset:0,length:10}],memoryIds:[],attempts:0,coverage:[{id:oldId,key:'generated-original-key',offset:0,length:10,fingerprint:'a'.repeat(64),state:'no_candidates',memoryIds:[],continuationBatchIds:['generated-child-batch']}]}));
 const child={id:childId,status:'running',createdAt:at,updatedAt:at,evidenceIds:[newId],memoryIds:[],materialInputs:[{materialId:material,fingerprint:'b'.repeat(64),evidenceIds:[newId],required:['body']}],materialRefs:{[newId]:'generated-current-ref'}};
 store.db.prepare('INSERT INTO memory_jobs VALUES(?,?,?)').run(childId,at,JSON.stringify(child));
 store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run('generated-child-batch',childId,0,JSON.stringify({id:'generated-child-batch',index:0,status:'running',evidenceRanges:[{id:newId,offset:0,length:10}],memoryIds:[],attempts:0,coverage:[{id:newId,key:'generated-child-key',offset:0,length:10,fingerprint:'b'.repeat(64),state:'pending',memoryIds:[]}]}));
 store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.continuationOf',?) WHERE id=?").run(rootId,childId);
 const goal=scope==='manual'?'memory:'+rootId:'memory-import:generated-import';
 const assertCurrent=()=>{const cards=activity.page().items.filter(item=>item.kind==='memory');assert.equal(cards.length,1);assert.equal(cards[0].id,goal);assert.equal(cards[0].state,'running');assert.equal(cards[0].progress.mode==='determinate'&&cards[0].progress.total,1);assert.deepEqual(cards[0].technical?.operationIds,['memory:'+childId,'memory:'+rootId]);const detail=activity.detail(goal);assert.deepEqual(detail.progress,cards[0].progress);assert.equal(detail.state,'running');};assertCurrent();
 // Simulate projection repair after a persisted owner continuation was present.
 store.db.prepare('DELETE FROM activity_memory_continuations WHERE job_id=?').run(childId);activity=new ActivityProjection(store,operations);assertCurrent();
 store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','completed','$.coverage[0].state','no_candidates') WHERE id=?").run('generated-child-batch');store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','completed') WHERE id=?").run(childId);
 const completed=activity.page({state:'completed'}).items.find(item=>item.id===goal)!;assert.ok(completed);assert.equal(completed.progress.mode==='determinate'&&completed.progress.completed,1);assert.deepEqual(activity.detail(goal).progress,completed.progress);
});
