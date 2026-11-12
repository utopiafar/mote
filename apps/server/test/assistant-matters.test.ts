import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {EvidenceDependencies} from '@mote/shared';
import {ZodError} from 'zod';
import {AssistantMatters,type MatterAuthority} from '../src/assistant-matters.js';
import {Store,StoreError} from '../src/store.js';
import {TaskRecords,type AssertTaskCurrent} from '../src/task-records.js';

const conflict=(error:unknown)=>error instanceof StoreError&&error.statusCode===409;
const invalid=(error:unknown)=>error instanceof ZodError;
const dependencies=(ids:string[]=[]):EvidenceDependencies=>({version:1,complete:true,ids});
const currentOriginals=(store:Store):AssertTaskCurrent=>ids=>{
  if(ids.some(id=>!store.isCurrentEvidence(id)))throw new StoreError('Generated authorization changed',409);
};
async function capture(store:Store,title:string,body:string,sourceId?:string){
  const id=randomUUID();
  await store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:sourceId?'file':'screen',
    capturedAt:'2026-10-01T00:00:00Z',durationMs:0,windowTitle:title,ocrText:body,
    ...(sourceId?{provenance:{sourceId,externalId:'generated-item',revision:'1',layer:'original' as const}}:{})});
  return id;
}
function authorityFor(store:Store,allowed:Set<string>,tasks?:TaskRecords):MatterAuthority{
  return {
    currentEvidence:ids=>ids.flatMap(id=>{
      if(!allowed.has(id))return [];
      const record=store.evidence([id])[0];
      if(!record)return [];
      return [{id,title:record.windowTitle||record.appName||'',sourceId:record.provenance?.sourceId,
        deviceId:record.deviceId,at:record.capturedAt}];
    }),
    currentTask:id=>{
      if(!tasks)return undefined;
      try{
        const task=tasks.get(id);
        return {id:task.id,state:task.state,revision:task.revision,updatedAt:task.updatedAt};
      }catch{return undefined;}
    },
  };
}

test('matter create, edit, pause, resume and archive round trip with archived history',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-matters-roundtrip-'));let store=new Store(directory);
  t.after(()=>{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  let matters=new AssistantMatters(store),tasks=new TaskRecords(store);
  const a=await capture(store,'Generated A title','Generated A body'),b=await capture(store,'Generated B title','Generated B body');
  const authority=authorityFor(store,new Set([a,b]),tasks);
  const task=tasks.create({operationId:randomUUID(),kind:'generated.matter',requestId:randomUUID(),
    input:{goal:'Generated linked task'},evidenceDependencies:dependencies([a])},currentOriginals(store));
  const create={type:'create' as const,requestId:randomUUID(),goal:'Generated matter goal',scope:{kind:'all' as const},
    taskIds:[task.id],evidenceIds:[a],correction:'Generated initial owner wording'};
  const created=matters.command(create,authority);
  assert.equal(created.state,'active');assert.equal(created.revision,1);assert.equal(created.createdAt,created.updatedAt);
  assert.deepEqual(matters.command(structuredClone(create),authority),created,'a lost create response replays one matter');
  assert.throws(()=>matters.command({...create,goal:'Generated different goal'},authority),conflict,'the same request ID cannot change content');

  const edited=matters.command({type:'edit',matterId:created.id,expectedRevision:1,goal:'Generated corrected goal',
    evidenceIds:[b,a],correction:'Generated explicit owner correction'},authority);
  assert.equal(edited.revision,2);assert.equal(edited.goal,'Generated corrected goal');
  assert.deepEqual(edited.evidenceIds,[a,b].sort());assert.equal(edited.correction,'Generated explicit owner correction');
  const paused=matters.command({type:'pause',matterId:edited.id,expectedRevision:2},authority);
  assert.equal(paused.state,'paused');assert.equal(paused.revision,3);
  const resumed=matters.command({type:'resume',matterId:paused.id,expectedRevision:3},authority);
  assert.equal(resumed.state,'active');assert.equal(resumed.revision,4);
  const archived=matters.command({type:'archive',matterId:resumed.id,expectedRevision:4},authority);
  assert.equal(archived.state,'archived');assert.equal(archived.revision,5);assert.ok(archived.archivedAt);
  assert.equal(matters.automaticWorkAllowed(archived.id),false);
  assert.deepEqual(matters.page({state:'archived'}).items.map(item=>item.id),[created.id]);
  assert.deepEqual(matters.page({state:'active'}).items,[]);
  assert.throws(()=>matters.command({type:'edit',matterId:archived.id,expectedRevision:5,goal:'Generated late edit'},authority),conflict);
  assert.throws(()=>matters.command({type:'pause',matterId:archived.id,expectedRevision:5},authority),conflict);

  const history=matters.history(created.id);
  assert.deepEqual(history.map(item=>item.command),['create','edit','pause','resume','archive']);
  assert.deepEqual(history.map(item=>item.revision),[1,2,3,4,5]);
  assert.equal(history[0].goal,'Generated matter goal');
  assert.equal(history[1].goal,'Generated corrected goal');
  assert.equal(history[1].correction,'Generated explicit owner correction');
  assert.equal(history.at(-1)?.state,'archived');

  store.close();store=new Store(directory);matters=new AssistantMatters(store);tasks=new TaskRecords(store);
  assert.deepEqual(matters.get(created.id),archived,'the archived matter survives restart');
  assert.deepEqual(matters.history(created.id).map(item=>item.command),['create','edit','pause','resume','archive']);
});

test('two clients see a revision conflict instead of overwriting the other end',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-matters-conflict-')),store=new Store(directory),matters=new AssistantMatters(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store,'Generated conflict title','Generated conflict body'),authority=authorityFor(store,new Set([a]));
  const created=matters.command({type:'create',requestId:randomUUID(),goal:'Generated shared goal',scope:{kind:'all'},evidenceIds:[a]},authority);
  const left=new AssistantMatters(store),right=new AssistantMatters(store);
  const paused=left.command({type:'pause',matterId:created.id,expectedRevision:1},authority);
  assert.throws(()=>right.command({type:'edit',matterId:created.id,expectedRevision:1,goal:'Generated stale client goal'},authority),conflict);
  assert.equal(right.get(created.id).state,'paused');assert.equal(right.get(created.id).revision,paused.revision);
  assert.equal(right.get(created.id).goal,'Generated shared goal','the losing client did not overwrite the winner');
  const archived=right.command({type:'archive',matterId:created.id,expectedRevision:2},authority);
  assert.equal(archived.state,'archived');assert.equal(left.get(created.id).revision,3);
});

test('pause blocks new automatic work while existing tasks keep their own lifecycle',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-matters-pause-')),store=new Store(directory),matters=new AssistantMatters(store),tasks=new TaskRecords(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store,'Generated pause title','Generated pause body'),authority=authorityFor(store,new Set([a]),tasks);
  const task=tasks.create({operationId:randomUUID(),kind:'generated.matter',requestId:randomUUID(),
    input:{goal:'Generated existing task'},evidenceDependencies:dependencies([a])},currentOriginals(store));
  const created=matters.command({type:'create',requestId:randomUUID(),goal:'Generated pause goal',scope:{kind:'all'},taskIds:[task.id]},authority);
  assert.equal(matters.automaticWorkAllowed(created.id),true);
  const paused=matters.command({type:'pause',matterId:created.id,expectedRevision:1},authority);
  assert.equal(paused.state,'paused');
  assert.equal(matters.automaticWorkAllowed(created.id),false);
  assert.throws(()=>matters.assertAutomaticWorkAllowed(created.id),conflict);
  assert.deepEqual(tasks.get(task.id),task,'pausing a matter does not cancel or rewrite existing work');
  assert.equal(tasks.setState(task.id,task.revision,'running').state,'running','existing work keeps its own rules');
  const resumed=matters.command({type:'resume',matterId:created.id,expectedRevision:2},authority);
  assert.equal(matters.automaticWorkAllowed(created.id),true);
  const archived=matters.command({type:'archive',matterId:resumed.id,expectedRevision:3},authority);
  assert.equal(archived.state,'archived');assert.equal(matters.automaticWorkAllowed(created.id),false);
});

test('deleting linked evidence removes its title and task answer without hiding the matter goal',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-matters-delete-')),store=new Store(directory),matters=new AssistantMatters(store),tasks=new TaskRecords(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const deleted=await capture(store,'Generated deleted title','Generated deleted body'),visible=await capture(store,'Generated visible title','Generated visible body');
  const authority=authorityFor(store,new Set([deleted,visible]),tasks),authorize=currentOriginals(store);
  const task=tasks.create({operationId:randomUUID(),kind:'generated.matter',requestId:randomUUID(),
    input:{goal:'Generated linked task'},evidenceDependencies:dependencies([deleted])},authorize);
  const result=tasks.saveResult(task.id,task.revision,{answer:'Generated linked task answer body'},dependencies([deleted]),authorize);
  const created=matters.command({type:'create',requestId:randomUUID(),goal:'Generated durable goal',scope:{kind:'all'},
    taskIds:[task.id],evidenceIds:[deleted,visible]},authority);
  const before=matters.detail(created.id,authority);
  assert.deepEqual(new Set(before.linkedEvidence.map(item=>item.id)),new Set([deleted,visible]));
  assert.match(JSON.stringify(before),/Generated deleted title/);assert.equal(before.coverage.evidence,'complete');

  store.delete(deleted);
  const after=matters.detail(created.id,authority);
  assert.deepEqual(after.linkedEvidence.map(item=>item.id),[visible],'deleted evidence is not shown as current');
  assert.equal(after.coverage.evidence,'partial');assert.equal(after.coverage.tasks,'complete');
  assert.equal(after.matter.goal,'Generated durable goal','owner-authored matter content remains');
  assert.equal(tasks.get(task.id).state,'stale');
  assert.equal(after.linkedTasks[0].state,'stale','the stale task link stays visible as metadata only');
  assert.throws(()=>tasks.result(task.id,result.revision,authorize),conflict);
  assert.doesNotMatch(JSON.stringify(after),/Generated deleted title|Generated deleted body|Generated linked task answer body/);
});

test('a saved scope never authorizes links or disclosure after current access is revoked',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-matters-scope-')),store=new Store(directory),matters=new AssistantMatters(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store,'Generated scoped A','Generated scoped A body','generated-source-a');
  const b=await capture(store,'Generated scoped B','Generated scoped B body','generated-source-b');
  const allowed=new Set([a,b]),authority=authorityFor(store,allowed);
  const scope={kind:'selection' as const,sourceIds:['generated-source-a']};
  assert.throws(()=>matters.command({type:'create',requestId:randomUUID(),goal:'Generated invalid scope',scope,evidenceIds:[b]},authority),conflict,
    'a link outside the saved selection is refused');
  const created=matters.command({type:'create',requestId:randomUUID(),goal:'Generated scoped goal',scope,evidenceIds:[a]},authority);
  assert.deepEqual(matters.detail(created.id,authority).linkedEvidence.map(item=>item.id),[a]);

  allowed.delete(a);
  const after=matters.detail(created.id,authority);
  assert.deepEqual(after.linkedEvidence,[],'the stored scope snapshot is not a current grant');
  assert.equal(after.coverage.evidence,'partial');
  assert.equal(after.matter.goal,'Generated scoped goal');
  assert.throws(()=>matters.command({type:'edit',matterId:created.id,expectedRevision:1,evidenceIds:[a]},authority),conflict,
    'an edit rechecks current access instead of trusting creation-time scope');
});

test('typed commands reject model-injected state and keyword completion',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-matters-commands-')),store=new Store(directory),matters=new AssistantMatters(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store,'Generated command title','Generated command body'),authority=authorityFor(store,new Set([a]));
  assert.throws(()=>matters.command({type:'create',requestId:randomUUID(),goal:'Generated goal',scope:{kind:'all'},state:'completed'},authority),invalid);
  assert.throws(()=>matters.command({type:'create',requestId:randomUUID(),goal:'   ',scope:{kind:'all'}},authority),invalid);
  const created=matters.command({type:'create',requestId:randomUUID(),goal:'Generated goal',scope:{kind:'all'},evidenceIds:[a]},authority);
  assert.throws(()=>matters.command({type:'edit',matterId:created.id,expectedRevision:1},authority),invalid);
  assert.throws(()=>matters.command({type:'edit',matterId:created.id,expectedRevision:1,status:'completed'},authority),invalid);
  assert.throws(()=>matters.command({type:'complete',matterId:created.id,expectedRevision:1},authority),invalid);
  assert.equal(matters.get(created.id).revision,1,'refused commands write nothing');
});

test('matter goals and corrections obey vault encryption and survive restart',async t=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'mote-matters-private-'))),key='43'.repeat(32);
  let store=new Store(directory,{dataKey:key,contentEncryptionEnabled:true}),matters=new AssistantMatters(store);
  t.after(()=>{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  const a=await capture(store,'Generated private title','Generated private body'),authority=authorityFor(store,new Set([a]));
  const created=matters.command({type:'create',requestId:randomUUID(),goal:'Generated private matter goal',scope:{kind:'all'},
    evidenceIds:[a],correction:'Generated private correction'},authority);
  const raw=String(store.db.prepare('SELECT json FROM assistant_matters WHERE id=?').get(created.id)!.json);
  const history=String(store.db.prepare('SELECT json FROM assistant_matter_revisions WHERE matter_id=?').get(created.id)!.json);
  assert.ok(raw.startsWith('aes:'));assert.ok(history.startsWith('aes:'));
  assert.ok(!raw.includes('Generated private matter goal'));assert.ok(!history.includes('Generated private correction'));
  store.close();store=new Store(directory,{dataKey:key});matters=new AssistantMatters(store);
  assert.deepEqual(matters.get(created.id),created);
  assert.equal(matters.history(created.id)[0].correction,'Generated private correction');
});
