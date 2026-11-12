import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {EvidenceDependencies} from '@mote/shared';
import {Store,StoreError} from '../src/store.js';
import {TaskRecords,type AssertTaskCurrent} from '../src/task-records.js';
import {invalidateTaskEvidence} from '../src/task-evidence.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {installEvidenceDependencies} from '../src/evidence-dependencies.js';
import {restoreProfile,verifiedBackup} from '../../../scripts/profile-lib.mjs';

const dependencies=(ids:string[]=[]):EvidenceDependencies=>({version:1,complete:true,ids});
const request=(ids:string[]=[])=>({operationId:randomUUID(),kind:'generated.task',requestId:randomUUID(),input:{instruction:'Generated private request'},evidenceDependencies:dependencies(ids)});
const conflict=(error:unknown)=>error instanceof StoreError&&error.statusCode===409;
const quota=(error:unknown)=>error instanceof StoreError&&error.statusCode===507;
const ownerInputOnly:AssertTaskCurrent=ids=>assert.deepEqual(ids,[]);
const currentOriginals=(store:Store):AssertTaskCurrent=>ids=>{if(ids.some(id=>!store.isCurrentEvidence(id)))throw new StoreError('Generated scope or version changed',409);};
async function capture(store:Store,text='Generated original'){
  const id=randomUUID();await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:text});return id;
}

test('lost task responses replay one immutable request after restart and conflicting content is rejected',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-idempotency-'));let store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  let tasks=new TaskRecords(store);const input=request();input.input={instruction:'Generated private request'};
  const initial=tasks.create(input,ownerInputOnly);
  assert.deepEqual(tasks.create(structuredClone(input),()=>assert.fail('a replay grants no new work')),initial);
  assert.throws(()=>tasks.create({...input,input:{instruction:'Different request'}},ownerInputOnly),conflict);
  assert.equal(tasks.page().items.length,1);
  const running=tasks.setState(initial.id,initial.revision,'running');
  assert.equal(running.revision,2);
  assert.throws(()=>tasks.saveResult(initial.id,initial.revision,{answer:'Old worker'},dependencies(),ownerInputOnly),conflict);
  store.close();store=new Store(directory);tasks=new TaskRecords(store);
  assert.deepEqual(tasks.create(input,()=>assert.fail('restart replay must not re-admit')),running);
  assert.deepEqual(tasks.input(initial.id,running.revision,ownerInputOnly),input.input);
  const result={answer:'Generated completed task',citations:[],trace:[],runId:randomUUID()};
  const completed=tasks.saveResult(initial.id,running.revision,result,dependencies(),ownerInputOnly);
  assert.equal(completed.state,'succeeded');assert.equal(completed.revision,3);
  assert.deepEqual(tasks.result(initial.id,completed.revision,ownerInputOnly),result);
  assert.throws(()=>tasks.saveResult(initial.id,running.revision,{answer:'Second writer'},dependencies(),ownerInputOnly),conflict);
  assert.throws(()=>tasks.setState(initial.id,completed.revision,'running'),conflict);
});

test('task pages keep stable creation ordering while state changes and newer tasks arrive',t=>{
  let clock=0;
  const directory=mkdtempSync(join(tmpdir(),'mote-task-pages-')),store=new Store(directory),tasks=new TaskRecords(store,()=>new Date(Date.UTC(2026,9,1)+clock++).toISOString());
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const operationId=randomUUID();
  const records=Array.from({length:5},()=>tasks.create({...request(),operationId},ownerInputOnly));
  tasks.create(request(),ownerInputOnly);
  const first=tasks.page({operationId,limit:2});
  const changed=first.items[0];tasks.setState(changed.id,changed.revision,'running');
  tasks.create({...request(),operationId},ownerInputOnly);
  const second=tasks.page({operationId,limit:2,cursor:first.nextCursor!}),third=tasks.page({operationId,limit:2,cursor:second.nextCursor!});
  assert.deepEqual(new Set([...first.items,...second.items,...third.items].map(item=>item.id)),new Set(records.map(item=>item.id)));
  assert.equal(first.items.length+second.items.length+third.items.length,5);assert.equal(third.nextCursor,null);
  assert.deepEqual(tasks.page({operationId,state:'running'}).items.map(item=>item.id),[changed.id]);
  assert.throws(()=>tasks.page({limit:0}));assert.throws(()=>tasks.page({cursor:'invalid'}),/Invalid task record cursor/);
});

test('quota failures and interrupted acceptance leave neither private inputs nor idempotency receipts, even in a caller transaction',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-atomic-'));let store=new Store(directory);
  const budget=store.logicalBytes()+2500;store.close();store=new Store(directory,{maxStorageBytes:budget});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const tasks=new TaskRecords(store),before=store.logicalBytes(),tooLarge=request();
  store.db.exec('BEGIN IMMEDIATE');
  assert.throws(()=>tasks.create({...tooLarge,input:{body:'Generated quota body '.repeat(300)}},ownerInputOnly),quota);
  assert.equal(store.db.isTransaction,true);store.db.exec('COMMIT');
  assert.equal(tasks.page().items.length,0);assert.equal(store.logicalBytes(),before);
  const saved=tasks.create(tooLarge,ownerInputOnly);
  assert.throws(()=>tasks.saveResult(saved.id,saved.revision,{body:'Generated quota result '.repeat(300)},dependencies(),ownerInputOnly),quota);
  assert.deepEqual(tasks.get(saved.id),saved);assert.equal(tasks.result(saved.id,saved.revision,ownerInputOnly),undefined);
  const interrupted=request();
  store.db.exec(`CREATE TRIGGER generated_task_interrupt AFTER INSERT ON task_records BEGIN SELECT RAISE(ABORT,'generated interruption'); END; BEGIN IMMEDIATE;`);
  assert.throws(()=>tasks.create(interrupted,ownerInputOnly),/generated interruption/);
  store.db.exec('DROP TRIGGER generated_task_interrupt; COMMIT');
  assert.equal(tasks.page().items.length,1);
  store.db.exec('BEGIN IMMEDIATE');tasks.create(interrupted,ownerInputOnly);store.db.exec('ROLLBACK');
  assert.equal(tasks.page().items.length,1);
  assert.equal(tasks.create(interrupted,ownerInputOnly).revision,1);
});

test('deleting A erases its frozen inputs and real stored results, leaves B intact and fences late writes',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-delete-')),store=new Store(directory),tasks=new TaskRecords(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store,'Generated secret A'),b=await capture(store,'Generated independent B'),authorize=currentOriginals(store);
  const inputA={...request([a]),input:{body:store.evidence([a])[0].ocrText}},inputB={...request([b]),input:{body:store.evidence([b])[0].ocrText}};
  const aTask=tasks.create(inputA,authorize),bTask=tasks.create(inputB,authorize),pending=tasks.create(request([a]),authorize);
  const both=tasks.create(request([a,b]),authorize);
  const resultA=tasks.saveResult(aTask.id,aTask.revision,{answer:store.evidence([a])[0].ocrText,citations:[{id:a}]},dependencies([a]),authorize);
  const resultB=tasks.saveResult(bTask.id,bTask.revision,{answer:store.evidence([b])[0].ocrText,citations:[{id:b}]},dependencies([b]),authorize);
  store.delete(a);
  for(const old of [resultA,pending,both]){
    const stale=tasks.get(old.id);assert.equal(stale.state,'stale');assert.equal(stale.revision,old.revision+1);
    const row=store.db.prepare('SELECT input_json,result_json FROM task_records WHERE id=?').get(old.id)!;
    assert.equal(row.input_json,null);assert.equal(row.result_json,null);
    assert.throws(()=>tasks.input(old.id,stale.revision,authorize),conflict);
    assert.throws(()=>tasks.saveResult(old.id,old.revision,{answer:'Late A'},dependencies([a]),authorize),conflict);
  }
  assert.deepEqual(tasks.get(bTask.id),resultB);assert.deepEqual(tasks.input(bTask.id,resultB.revision,authorize),inputB.input);
  assert.deepEqual(tasks.result(bTask.id,resultB.revision,authorize),{answer:'Generated independent B',citations:[{id:b}]});
  assert.deepEqual(tasks.create(inputA,()=>assert.fail('deleted input must never be restored')),tasks.get(aTask.id));
  assert.deepEqual(new Set(tasks.byEvidence(a).map(task=>task.id)),new Set([aTask.id,pending.id,both.id]));
});

test('result-only evidence is retained in lineage and withdrawal clears the initial input too',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-results-')),store=new Store(directory),tasks=new TaskRecords(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store),b=await capture(store),authorize=currentOriginals(store),task=tasks.create(request([b]),authorize);
  const completed=tasks.saveResult(task.id,task.revision,{answer:'Generated derived A and B'},dependencies([a]),authorize);
  assert.equal(tasks.byEvidence(a)[0].id,task.id);assert.equal(tasks.byEvidence(b)[0].id,task.id);
  assert.deepEqual(new Set(tasks.evidenceDependencies(task.id,completed.revision,authorize).ids),new Set([a,b]));
  store.db.exec('BEGIN IMMEDIATE');store.invalidateSemanticEvidence(a,true);store.db.exec('COMMIT');
  assert.equal(tasks.get(task.id).state,'stale');
  assert.throws(()=>tasks.result(task.id,completed.revision,authorize),conflict);
  assert.equal(store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(task.id)!.input_json,null);
});

test('source revisions invalidate task recovery inputs and preserve unrelated source tasks',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-source-')),store=new Store(directory),tasks=new TaskRecords(store),sources=new SourceStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-source',name:'Generated source',kind:'custom',deviceId:'generated',platform:'import'});
  const item={externalId:'generated-item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message' as const,layer:'original' as const,text:'Generated old version'};
  const a=await sources.upsert('generated-source',item),b=await capture(store),authorize=currentOriginals(store);
  const old=tasks.create(request([a.id]),authorize),other=tasks.create(request([b]),authorize);
  await sources.upsert('generated-source',{...item,revision:'2',observedAt:'2026-10-02T00:00:00Z',text:'Generated new version'});
  assert.equal(tasks.get(old.id).state,'stale');assert.deepEqual(tasks.get(other.id),other);
  assert.throws(()=>tasks.saveResult(old.id,old.revision,{},dependencies([a.id]),authorize),conflict);
});

test('derived Material dependencies follow actual original lineage across deletion and pending tasks',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-material-')),store=new Store(directory),tasks=new TaskRecords(store),materials=new MaterialStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const raw=await capture(store,'Generated Material original');
  const material=materials.publish({id:materialId('generated-task','body'),kind:'mote.note',schemaVersion:1,title:'Generated task evidence',origin:{sourceId:'generated-task',externalId:'body',deviceId:'generated'},members:[{id:raw,kind:'capture',ref:'capture:'+raw}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated Material original',memberIds:[raw]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  installEvidenceDependencies(store);
  const anchor=materials.evidenceIds(material.ref)[0],authorize:AssertTaskCurrent=ids=>{for(const id of ids)assert.ok(store.isCurrentEvidence(id)||materials.isCurrentEvidence(id));};
  const pending=tasks.create({...request([anchor]),input:materials.read(material.ref,{length:100})},authorize);
  assert.equal(tasks.byEvidence(raw)[0].id,pending.id);
  store.delete(raw);
  assert.equal(tasks.get(pending.id).state,'stale');assert.equal(store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(pending.id)!.input_json,null);
});

test('domain cleanup participates in evidence deletion and a failed cleanup rolls back the original and task bodies',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-domain-cleanup-')),store=new Store(directory),tasks=new TaskRecords(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const id=await capture(store),authorize=currentOriginals(store),task=tasks.create(request([id]),authorize);
  store.db.exec(`CREATE TABLE generated_task_cards(task_id TEXT PRIMARY KEY,body TEXT);
    CREATE TRIGGER generated_task_cards_retired AFTER UPDATE OF state ON task_records WHEN new.state='stale' AND old.state!='stale' BEGIN DELETE FROM generated_task_cards WHERE task_id=new.id; END;
    CREATE TRIGGER generated_task_cleanup_interrupted BEFORE DELETE ON generated_task_cards BEGIN SELECT RAISE(ABORT,'generated cleanup interruption'); END;`);
  store.db.prepare('INSERT INTO generated_task_cards VALUES(?,?)').run(task.id,'Generated derived card');
  assert.throws(()=>store.delete(id),/generated cleanup interruption/);
  assert.equal(store.evidence([id]).length,1);assert.deepEqual(tasks.get(task.id),task);assert.deepEqual(tasks.input(task.id,task.revision,authorize),request().input);
  assert.equal(store.db.prepare('SELECT count(*) n FROM generated_task_cards').get()!.n,1);
  store.db.exec('DROP TRIGGER generated_task_cleanup_interrupted');store.delete(id);
  assert.equal(store.db.prepare('SELECT count(*) n FROM generated_task_cards').get()!.n,0);assert.equal(tasks.get(task.id).state,'stale');
});

test('private task bodies obey vault encryption, survive complete backup and never appear in ordinary metadata or error messages',async t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'mote-task-backup-'))),source=join(directory,'source'),snapshot=join(directory,'snapshot'),target=join(directory,'restored'),key='43'.repeat(32);
  let store=new Store(source,{dataKey:key,contentEncryptionEnabled:true});let tasks=new TaskRecords(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const input={...request(),input:{body:'Generated private input marker',model:{id:'generated'}}},task=tasks.create(input,ownerInputOnly);
  const finished=tasks.saveResult(task.id,task.revision,{answer:'Generated private result marker'},dependencies(),ownerInputOnly);
  assert.equal(statSync(source).mode&0o777,0o700);assert.equal(statSync(join(source,'mote.sqlite')).mode&0o777,0o600);
  const raw=String(store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(task.id)!.input_json);assert.ok(raw.startsWith('aes:'));assert.ok(!raw.includes('Generated private'));
  const publicValue=JSON.stringify({task:tasks.get(task.id),page:tasks.page(),dependencies:tasks.byEvidence('absent')});assert.ok(!publicValue.includes('Generated private'));
  let circular:any={body:'Generated private input marker'};circular.circular=circular;
  assert.throws(()=>tasks.create({...request(),input:circular},ownerInputOnly),error=>error instanceof StoreError&&!String(error).includes('Generated private'));
  assert.throws(()=>tasks.saveResult(task.id,finished.revision,{answer:'Generated private result marker'},dependencies(),ownerInputOnly),error=>conflict(error)&&!String(error).includes('Generated private'));
  const bytes=store.storageBreakdown().plugins.find(plugin=>plugin.plugin==='task-records')!.bytes;assert.ok(bytes>raw.length);
  store.close();
  execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url)),'--data',source,'--out',snapshot],{stdio:'pipe'});
  await verifiedBackup(snapshot);
  assert.ok(!readFileSync(join(snapshot,'backup-manifest.json'),'utf8').includes('Generated private'));
  await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(directory,'absent-process')},snapshot);
  store=new Store(target,{dataKey:key});tasks=new TaskRecords(store);
  assert.deepEqual(tasks.get(task.id),finished);assert.deepEqual(tasks.input(task.id,finished.revision,ownerInputOnly),input.input);assert.deepEqual(tasks.result(task.id,finished.revision,ownerInputOnly),{answer:'Generated private result marker'});
  assert.equal(store.storageBreakdown().plugins.find(plugin=>plugin.plugin==='task-records')!.bytes,bytes);
});

test('current permission checks are required for every private read and result write, including newly read evidence',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-task-permissions-')),store=new Store(directory),tasks=new TaskRecords(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store),b=await capture(store),allowed=new Set([a,b]);
  const authorize:AssertTaskCurrent=ids=>{if(ids.some(id=>!allowed.has(id)))throw new StoreError('Generated scope revoked',409);};
  const task=tasks.create(request([a]),authorize);allowed.delete(a);
  const unresolved=async()=>{throw new StoreError('Generated asynchronous denial',409);};
  assert.throws(()=>tasks.create(request(),unresolved),conflict);
  assert.throws(()=>tasks.input(task.id,task.revision,unresolved),conflict);
  assert.throws(()=>tasks.saveResult(task.id,task.revision,{answer:'Unchecked'},dependencies([b]),unresolved),conflict);
  assert.throws(()=>tasks.input(task.id,task.revision,authorize),conflict);
  assert.throws(()=>tasks.saveResult(task.id,task.revision,{answer:'Revoked'},dependencies([b]),authorize),conflict);
  allowed.add(a);allowed.delete(b);
  assert.throws(()=>tasks.saveResult(task.id,task.revision,{answer:'Mixed scope'},dependencies([b]),authorize),conflict);
  assert.deepEqual(tasks.get(task.id),task);assert.equal(tasks.byEvidence(b).length,0);
  assert.throws(()=>tasks.create({...request(),evidenceDependencies:{version:1,complete:false,ids:[a]}},authorize),conflict);
  store.db.exec('BEGIN IMMEDIATE');invalidateTaskEvidence(store,[a]);store.db.exec('COMMIT');
  const cancelled=tasks.create(request(),ownerInputOnly),stopped=tasks.setState(cancelled.id,cancelled.revision,'cancelled');
  assert.throws(()=>tasks.saveResult(cancelled.id,stopped.revision,{},dependencies(),ownerInputOnly),conflict);
});
