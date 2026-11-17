import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {ActivityMemoryIndex} from '../src/activity-memory-index.js';
import {ExecutionEngine} from '../src/execution-engine.js';

const at='2026-10-01T03:00:00.000Z';
function fixture(t:import('node:test').TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-activity-index-')),store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});new ActivityMemoryIndex(store);return store;}
function job(id:string,extra:Record<string,unknown>={}){return {id,createdAt:at,updatedAt:at,status:'queued',evidenceIds:[],materialInputs:[],materialRefs:{},memoryIds:[],...extra};}
function insert(store:Store,value:ReturnType<typeof job>){store.db.prepare('INSERT INTO memory_jobs(id,created_at,json) VALUES(?,?,?)').run(value.id,value.createdAt,JSON.stringify(value));}
function entries(store:Store,id:string){return store.db.prepare('SELECT ref,item_key FROM activity_memory_items WHERE job_id=? ORDER BY ref').all(id).map(row=>({...row}));}
const grants=(ref:string)=>`CASE WHEN json_type(${ref}.json,'$.automaticGrants')='array' THEN json_extract(${ref}.json,'$.automaticGrants') WHEN json_type(${ref}.json,'$.automaticGrant')='object' THEN json_array(json_extract(${ref}.json,'$.automaticGrant')) ELSE json('[]') END`;
// This is the installed pre-fix SQL, used as a migration/parity oracle. The
// expected keys below also spell out the public record identity contract.
const previousItems=(ref:string,from='')=>`SELECT CAST(e.value AS TEXT) ref,coalesce(
 (SELECT json_array(json_extract(w.value,'$.sourceId'),json_extract(w.value,'$.inputKey')) FROM json_each(${ref}.json,'$.workPackage.inputs') w WHERE json_extract(w.value,'$.materialId') IN (SELECT json_extract(p.value,'$.materialId') FROM json_each(${ref}.json,'$.materialInputs') p WHERE e.value IN (SELECT value FROM json_each(p.value,'$.evidenceIds'))) OR json_extract(w.value,'$.ref')=json_extract(${ref}.json,'$.materialRefs."'||e.value||'"') LIMIT 1),
 CASE WHEN json_array_length(${grants(ref)})=1 THEN (SELECT json_array(json_extract(g.value,'$.sourceId'),json_extract(g.value,'$.inputKey')) FROM json_each(${grants(ref)}) g LIMIT 1) END,
 (SELECT json_extract(p.value,'$.materialId')||':'||json_extract(p.value,'$.fingerprint') FROM json_each(${ref}.json,'$.materialInputs') p WHERE e.value IN (SELECT value FROM json_each(p.value,'$.evidenceIds')) LIMIT 1),CAST(e.value AS TEXT)) item_key FROM ${from}json_each(${ref}.json,'$.evidenceIds') e`;

test('Activity item mapping preserves first array match, work ref OR pin match, scopes and grant precedence',t=>{
 const store=fixture(t),refs=Array.from({length:6},()=>randomUUID()),[overlap,byRef,byPin,nullable,raw,last]=refs;
 const value=job('generated-identity',{evidenceIds:refs,materialInputs:[
  {materialId:'first-pin',fingerprint:'first',evidenceIds:[overlap,byPin]},
  {materialId:'second-pin',fingerprint:'second',evidenceIds:[overlap,last]},
  {materialId:'no-fingerprint',evidenceIds:[nullable]},
  {materialId:'later-fingerprint',fingerprint:'later',evidenceIds:[nullable]}],
  materialRefs:{[byRef]:'selected-ref',[overlap]:'another-ref'},
  workPackage:{inputs:[{materialId:'second-pin',sourceId:'first-work',inputKey:'shared',scope:'first'},
   {materialId:'first-pin',sourceId:'second-work',inputKey:'shared',scope:'second'},
   {ref:'selected-ref',sourceId:'ref-work',inputKey:'ref-item',scope:'manual'}]}});
 insert(store,value);
 const expected=new Map([[overlap,'["first-work","shared"]'],[byRef,'["ref-work","ref-item"]'],[byPin,'["second-work","shared"]'],[nullable,nullable],[raw,raw],[last,'["first-work","shared"]']]);
 assert.deepEqual(entries(store,value.id),[...expected].sort(([a],[b])=>a.localeCompare(b)).map(([ref,item_key])=>({ref,item_key})));
 // The job predicate belongs inside the source because j is not exported.
 const old=store.db.prepare(`SELECT * FROM (${previousItems('j','(SELECT * FROM memory_jobs WHERE id=?) j,')}) ORDER BY ref`).all(value.id);
 assert.deepEqual(entries(store,value.id),old.map(row=>({...row})));
 const single=job('generated-single-grant',{evidenceIds:[raw,byPin],materialInputs:value.materialInputs,automaticGrant:{sourceId:'grant-source',inputKey:'grant-item',scope:'owner'}});insert(store,single);
 assert.ok(entries(store,single.id).every(row=>row.item_key==='["grant-source","grant-item"]'));
 const multiple=job('generated-multiple-grants',{evidenceIds:[byPin,raw],materialInputs:value.materialInputs,automaticGrants:[{sourceId:'one',inputKey:'one',scope:'one'},{sourceId:'two',inputKey:'two',scope:'two'}]});insert(store,multiple);
 assert.equal(entries(store,multiple.id).find(row=>row.ref===byPin)!.item_key,'first-pin:first');assert.equal(entries(store,multiple.id).find(row=>row.ref===raw)!.item_key,raw);
 const empty=job('generated-explicit-empty-grants',{...single,id:'generated-explicit-empty-grants',automaticGrants:[]});insert(store,empty);assert.equal(entries(store,empty.id).find(row=>row.ref===byPin)!.item_key,'first-pin:first');
 assert.equal(JSON.parse(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(value.id)!.json)).createdAt,at);
 assert.doesNotMatch(JSON.stringify(entries(store,value.id)),/scope|owner|materialInputs/);
});

test('Activity ref corrections, input removal and job deletion update only the selected projection',t=>{
 const store=fixture(t),ref=randomUUID(),other=randomUUID(),value=job('generated-correction',{evidenceIds:[ref,other],materialRefs:{[ref]:'old-ref'},workPackage:{inputs:[{ref:'old-ref',sourceId:'old',inputKey:'item',scope:'first'},{ref:'new-ref',sourceId:'new',inputKey:'item',scope:'second'}]}});insert(store,value);
 assert.equal(entries(store,value.id).find(row=>row.ref===ref)!.item_key,'["old","item"]');
 store.db.prepare("UPDATE memory_jobs SET json=json_set(json,?,?) WHERE id=?").run('$.materialRefs."'+ref+'"','new-ref',value.id);assert.equal(entries(store,value.id).find(row=>row.ref===ref)!.item_key,'["new","item"]');
 store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.evidenceIds',json(?)) WHERE id=?").run(JSON.stringify([ref]),value.id);assert.deepEqual(entries(store,value.id).map(row=>row.ref),[ref]);
 insert(store,job('generated-unrelated',{evidenceIds:[other]}));store.db.prepare('DELETE FROM memory_jobs WHERE id=?').run(value.id);assert.equal(entries(store,value.id).length,0);assert.equal(entries(store,'generated-unrelated').length,1);assert.equal(store.db.prepare('SELECT count(*) n FROM activity_memory_jobs WHERE id=?').get(value.id)!.n,0);
});

test('installed legacy item triggers are replaced atomically and retain existing projections',t=>{
 const store=fixture(t),ref=randomUUID(),existing=job('generated-existing',{evidenceIds:[ref]});insert(store,existing);
 store.db.exec(`DROP TRIGGER activity_memory_job_insert;DROP TRIGGER activity_memory_items_update;
  CREATE TRIGGER activity_memory_job_insert AFTER INSERT ON memory_jobs BEGIN INSERT INTO activity_memory_jobs VALUES(new.id,new.created_at,new.created_at,'queued',NULL);INSERT INTO activity_memory_items SELECT new.id,ref,item_key FROM (${previousItems('new')});END;
  CREATE TRIGGER activity_memory_items_update AFTER UPDATE OF json ON memory_jobs BEGIN DELETE FROM activity_memory_items WHERE job_id=new.id;INSERT INTO activity_memory_items SELECT new.id,ref,item_key FROM (${previousItems('new')});END;`);
 const before=String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='activity_memory_job_insert'").get()!.sql),db=store.db as any,exec=db.exec;
 db.exec=function(sql:string){if(sql.startsWith('CREATE TABLE IF NOT EXISTS activity_memory_jobs'))throw Error('Generated trigger replacement interruption');return exec.call(this,sql);};
 assert.throws(()=>new ActivityMemoryIndex(store),/Generated trigger replacement interruption/);db.exec=exec;
 assert.equal(store.db.isTransaction,false);assert.equal(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='activity_memory_job_insert'").get()!.sql,before);assert.equal(entries(store,existing.id).length,1);
 new ActivityMemoryIndex(store);
 for(const name of ['activity_memory_job_insert','activity_memory_items_update'])assert.match(String(store.db.prepare('SELECT sql FROM sqlite_temp_master WHERE name=?').get(name)!.sql),/pins AS MATERIALIZED/);
 const next=job('generated-after-migration',{evidenceIds:[ref],materialInputs:[{materialId:'generated-material',fingerprint:'current',evidenceIds:[ref]}]});insert(store,next);assert.equal(entries(store,next.id)[0].item_key,'generated-material:current');assert.equal(entries(store,existing.id)[0].item_key,ref);
});

test('three generated 4097-anchor job inserts preserve a running default execution lease',async t=>{
 const store=fixture(t),engine=new ExecutionEngine(store);t.after(()=>engine.close());let release!:()=>void,entered!:()=>void;const active=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 engine.register({kind:'generated-running-work',pool:'generated-running-work',concurrency:()=>1,validate:()=>true,execute:async()=>{entered();await held;},commit:()=>{}});
 const stepId=engine.enqueue('generated-existing-operation','generated-running-work',{}),execution=engine.tick();await active;
 const fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)!.fence),refs=Array.from({length:4097},()=>randomUUID()),durations:number[]=[];
 for(let index=0;index<3;index++){const value=job('generated-large-'+index,{evidenceIds:refs,materialInputs:[{materialId:'generated-large-material',fingerprint:'a'.repeat(64),evidenceIds:refs}],materialRefs:Object.fromEntries(refs.map(ref=>[ref,'generated-current-ref']))}),started=performance.now();insert(store,value);durations.push(Math.round(performance.now()-started));assert.equal(entries(store,value.id).length,4097);assert.ok(entries(store,value.id).every(row=>row.item_key==='generated-large-material:'+'a'.repeat(64)));assert.equal(engine.isCurrentGrant(stepId,fence),true,'job projection must not expire the existing unextended lease');}
 release();await execution;assert.equal(engine.get(stepId)!.state,'succeeded');assert.equal(engine.get(stepId)!.attempts,1);t.diagnostic(JSON.stringify({generated:true,jobs:3,anchorsPerJob:4097,insertDurationMs:durations,leaseAttempts:1}));
});


test('phase progress leaves Activity batch projections intact while each actual input change refreshes them',t=>{
 const store=fixture(t),first=job('generated-first',{memoryIds:['job-memory']}),second=job('generated-second');insert(store,first);insert(store,second);
 const ref=randomUUID(),other=randomUUID(),batch={id:'generated-batch',status:'running',attempts:1,evidenceRanges:[{id:ref,offset:0,length:10}],memoryIds:['batch-memory']};
 store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run(batch.id,first.id,0,JSON.stringify(batch));
 const projection=()=>{const row=store.db.prepare('SELECT job_id,leaf,rank FROM activity_memory_batches WHERE id=?').get(batch.id);return row?{...row}:undefined;},coverage=()=>store.db.prepare('SELECT ref,state FROM activity_memory_coverage WHERE batch_id=? ORDER BY idx').all(batch.id).map(row=>({...row})),outputs=(id:string)=>store.db.prepare('SELECT memory_id FROM activity_memory_outputs WHERE job_id=? ORDER BY memory_id').all(id).map(row=>String(row.memory_id));
 store.db.exec("CREATE TABLE generated_projection_writes(kind TEXT);CREATE TRIGGER generated_batch_writes AFTER INSERT ON activity_memory_batches BEGIN INSERT INTO generated_projection_writes VALUES('batch');END;CREATE TRIGGER generated_coverage_writes AFTER INSERT ON activity_memory_coverage BEGIN INSERT INTO generated_projection_writes VALUES('coverage');END;CREATE TRIGGER generated_output_deletes AFTER DELETE ON activity_memory_outputs BEGIN INSERT INTO generated_projection_writes VALUES('output');END;");
 const before={projection:projection(),coverage:coverage(),outputs:outputs(first.id)};
 store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.phase','review','$.stage','model','$.attempts',2,'$.lastActivityAt',?) WHERE id=?").run('2026-10-01T04:00:00.000Z',batch.id);
 assert.deepEqual({projection:projection(),coverage:coverage(),outputs:outputs(first.id)},before);assert.equal(store.db.prepare('SELECT count(*) n FROM generated_projection_writes').get()!.n,0,'phase, stage, attempt and heartbeat updates cannot rebuild unchanged projections');
 const update=(path:string,value:unknown)=>store.db.prepare('UPDATE memory_batches SET json=json_set(json,?,json(?)) WHERE id=?').run(path,JSON.stringify(value),batch.id);
 update('$.status','completed');assert.equal(projection()!.rank,0);assert.deepEqual(coverage(),[{ref,state:'completed'}]);
 update('$.evidenceRanges',[{id:other,offset:0,length:10}]);assert.deepEqual(coverage(),[{ref:other,state:'completed'}]);
 update('$.coverage',[{id:other,key:'generated-key',state:'needs_context'}]);assert.equal(projection()!.rank,5);assert.deepEqual(coverage(),[{ref:other,state:'needs_input'}]);
 update('$.contextFeedbackChildId','generated-feedback-child');assert.equal(projection()!.rank,0);assert.deepEqual(coverage(),[]);
 update('$.contextFeedbackChildId',null);assert.equal(projection()!.rank,5);assert.equal(coverage().length,1,'SQL null changes the handoff fence');
 update('$.supersededBy',['generated-child']);assert.equal(projection()!.leaf,0);assert.deepEqual(coverage(),[]);
 update('$.supersededBy',[]);assert.equal(projection()!.leaf,1);assert.equal(coverage().length,1);
 update('$.memoryIds',['new-memory']);assert.deepEqual(outputs(first.id),['job-memory','new-memory']);
 store.db.prepare("UPDATE memory_batches SET job_id=?,json=json_set(json,'$.stage','moved') WHERE id=?").run(second.id,batch.id);assert.equal(projection()!.job_id,second.id);assert.deepEqual(outputs(first.id),['job-memory']);assert.deepEqual(outputs(second.id),['new-memory'],'a moved batch refreshes both old and new output owners');
 update('$.status','cancelled');assert.deepEqual(coverage(),[{ref:other,state:'needs_input'}]);
 update('$.status','invalidated');assert.equal(projection()!.rank,4);assert.deepEqual(coverage(),[{ref:other,state:'stale'}]);
 store.db.prepare('DELETE FROM activity_memory_batches WHERE id=?').run(batch.id);update('$.stage','repair-missing-projection');assert.equal(projection()!.job_id,second.id);assert.deepEqual(coverage(),[{ref:other,state:'stale'}]);
 store.db.prepare('DELETE FROM memory_batches WHERE id=?').run(batch.id);assert.equal(projection(),undefined);assert.deepEqual(coverage(),[]);assert.deepEqual(outputs(second.id),[]);assert.deepEqual(outputs(first.id),['job-memory']);
});

test('startup explicitly repairs a saved feedback handoff without relying on an unchanged source update',t=>{
 const store=fixture(t),value=job('generated-handoff',{memoryIds:['job-memory']});insert(store,value);const ref=randomUUID(),batch={id:'generated-handoff-batch',status:'completed',evidenceRanges:[{id:ref,offset:0,length:10}],memoryIds:['batch-memory'],contextFeedbackChildId:'generated-child',coverage:[{id:ref,key:'generated-key',state:'needs_context'}]};
 store.db.prepare('INSERT INTO memory_batches VALUES(?,?,?,?)').run(batch.id,value.id,0,JSON.stringify(batch));
 store.db.prepare('UPDATE activity_memory_batches SET leaf=0,rank=6 WHERE id=?').run(batch.id);store.db.prepare('INSERT INTO activity_memory_coverage VALUES(?,?,?,?,?)').run(batch.id,value.id,0,ref,'needs_input');store.db.prepare('DELETE FROM activity_memory_outputs WHERE job_id=?').run(value.id);
 const json=store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(batch.id)!.json;
 new ActivityMemoryIndex(store);
 assert.deepEqual({...store.db.prepare('SELECT leaf,rank FROM activity_memory_batches WHERE id=?').get(batch.id)},{leaf:1,rank:0});assert.equal(store.db.prepare('SELECT count(*) n FROM activity_memory_coverage WHERE batch_id=?').get(batch.id)!.n,0);
 assert.deepEqual(store.db.prepare('SELECT memory_id FROM activity_memory_outputs WHERE job_id=? ORDER BY memory_id').all(value.id).map(row=>row.memory_id),['batch-memory','job-memory']);assert.equal(store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(batch.id)!.json,json,'repair does not rewrite the original checkpoint');
});
