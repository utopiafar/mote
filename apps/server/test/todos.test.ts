import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {TodoStore} from '../src/todos.js';

test('tasks preserve absent deadlines, idempotency, version fences, status and restart pagination',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-tasks-'));let store=new Store(directory),todos=new TodoStore(store);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const input={id:randomUUID(),title:'联系合成客户'},first=todos.create(input);
 assert.equal(first.dueAt,null);assert.equal(first.status,'open');assert.deepEqual(todos.create(input),first);
 assert.throws(()=>todos.create({...input,title:'different'}),/conflicts/);
 assert.throws(()=>todos.create({title:'Bad evidence',evidenceIds:[randomUUID()]}),/evidence unavailable/);
 const completed=todos.update(first.id,{version:1,status:'completed'});assert.equal(completed.version,2);
 assert.throws(()=>todos.update(first.id,{version:1,status:'cancelled'}),/changed/);
 todos.update(first.id,{version:2,status:'open'});
 for(let i=0;i<137;i++)todos.create({title:'Generated '+i});
 store.close();store=new Store(directory);todos=new TodoStore(store);
 const seen=new Set<string>();let cursor:string|undefined;
 do{const page=todos.page({status:'open',limit:20,cursor});for(const item of page.items){assert.ok(!seen.has(item.id));seen.add(item.id);}cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(seen.size,138);assert.equal(todos.get(first.id).version,3);
 assert.equal(todos.page({status:'completed'}).items.length,0);
 assert.ok(store.logicalBytes()>10000);
});

test('portable backup restores tasks and create receipts without overwriting later local changes',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-task-backup-')),source=new Store(join(directory,'source')),target=new Store(join(directory,'target'));
 t.after(async()=>{source.close();target.close();await rm(directory,{recursive:true,force:true});});
 const sourceTasks=new TodoStore(source),targetTasks=new TodoStore(target),input={id:randomUUID(),title:'Generated portable task'};
 const created=sourceTasks.create(input);sourceTasks.update(created.id,{version:1,status:'completed'});
 const archive=source.exportArchive(100000);await target.importArchive(archive);await target.importArchive(archive);
 assert.equal(targetTasks.get(created.id).status,'completed');assert.equal(targetTasks.create(input).version,2);
 targetTasks.update(created.id,{version:2,title:'Updated locally'});await assert.rejects(target.importArchive(archive),/conflicts/);assert.equal(targetTasks.get(created.id).title,'Updated locally');
});
