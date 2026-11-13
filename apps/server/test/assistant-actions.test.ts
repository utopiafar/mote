import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assistantActionFixture,actionText,until} from './fixtures/assistant-actions.js';

test('a real assistant result creates one Todo or proposal per draft and returns live receipts to its original matter',async t=>{
 const f=await assistantActionFixture(t),taskId=await f.start();
 assert.equal(f.node.actions.list().length,0,'query and task completion cannot create Actions');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM todos').get()!.n,0);
 const {target:calendar}=await f.grant('calendar.manage'),{target:message}=await f.grant('message.send');
 const todo=await f.create(taskId,0);assert.equal(todo.response.statusCode,200,todo.response.body);
 const todoId=todo.response.json().drafts[0].linked.id;
 const duplicate=await f.request('POST','/api/assistant/action-commands',todo.payload);assert.equal(duplicate.statusCode,200,duplicate.body);
 assert.equal(duplicate.json().drafts[0].linked.id,todoId);assert.equal(duplicate.json().drafts[0].linked.status,'open','creating a Todo is not completing it');
 const calendarCreated=await f.create(taskId,1,calendar);assert.equal(calendarCreated.response.statusCode,200,calendarCreated.response.body);
 const calendarId=calendarCreated.response.json().drafts[1].linked.id;
 assert.equal(f.node.actions.get(calendarId).status,'proposed');assert.equal(f.calls.length,0);
 const first=await f.create(taskId,2,message);assert.equal(first.response.statusCode,200,first.response.body);
 const id=first.response.json().drafts[2].linked.id;
 const replay=await f.request('POST','/api/assistant/action-commands',first.payload);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().drafts[2].linked.id,id);
 await f.tick();assert.equal(f.calls.length,0,'a grant and a proposal never auto-send a message');
 const action=f.node.actions.get(id),confirmation={version:action.version,message:action.message,target:action.target};
 const confirmed=await f.request('POST','/api/actions/'+id+'/confirm',confirmation);assert.equal(confirmed.statusCode,200,confirmed.body);
 await until(()=>f.node.actions.get(id).status==='succeeded');
 assert.equal((await f.request('POST','/api/actions/'+id+'/confirm',confirmation)).statusCode,200);
 await f.tick();assert.equal(f.calls.length,1,'repeated creation and confirmation cannot duplicate the send');
 const live=await f.read(f.path(taskId)),receipt=live.drafts[2].linked;
 assert.equal(receipt.status,'succeeded');assert.equal(receipt.operationId,f.calls[0].operationId);assert.match(receipt.externalId,/generated-external-/);
 const matter=await f.read('/api/assistant/matters/'+f.matter.id+'/actions?'+new URLSearchParams({scope:JSON.stringify(f.scope)}));
 assert.equal(matter.items[0].taskId,taskId);assert.deepEqual(matter.items[0].drafts[2].linked,receipt);
 await f.restart();assert.deepEqual((await f.read(f.path(taskId))).drafts[2].linked,receipt);await f.tick();assert.equal(f.calls.length,1);
});

test('every message requires its own confirmation and a lost connector response stays uncertain after replay and restart',async t=>{
 const f=await assistantActionFixture(t),firstTask=await f.start(),{target}=await f.grant('message.send');
 const first=await f.create(firstTask,2,target);assert.equal(first.response.statusCode,200,first.response.body);
 const id=first.response.json().drafts[2].linked.id;f.setLoseResponse(true);
 const action=f.node.actions.get(id),confirmation={version:action.version,message:action.message,target};
 assert.equal((await f.request('POST','/api/actions/'+id+'/confirm',confirmation)).statusCode,200);
 await until(()=>f.node.actions.get(id).status==='uncertain');
 const receipt=(await f.read(f.path(firstTask))).drafts[2].linked;assert.equal(receipt.status,'uncertain');assert.equal(receipt.externalId,undefined);
 const secondTask=await f.start(),second=await f.create(secondTask,2,target);assert.equal(second.response.statusCode,200,second.response.body);
 assert.equal(second.response.json().drafts[2].linked.status,'proposed');await f.tick();assert.equal(f.calls.length,1,'confirming the first message never confirms a second one');
 assert.equal((await f.request('POST','/api/assistant/action-commands',first.payload)).statusCode,200);
 assert.equal((await f.request('POST','/api/actions/'+id+'/confirm',confirmation)).statusCode,200);
 await f.restart();await f.tick();assert.equal(f.calls.length,1,'uncertain external effects are never automatically retried');
 const matter=await f.read('/api/assistant/matters/'+f.matter.id+'/actions?'+new URLSearchParams({scope:JSON.stringify(f.scope)}));
 assert.equal(matter.items.find((item:any)=>item.taskId===firstTask).drafts[2].linked.status,'uncertain');
});

test('calendar proposals reject a grant for another source, an empty scope, a forged target and collector commands',async t=>{
 const f=await assistantActionFixture(t),taskId=await f.start();
 f.node.sources.register({id:'generated-other',kind:'custom',name:'Generated other',deviceId:'generated-input',platform:'import'});
 const {target}=await f.grant('calendar.manage','generated-other');
 assert.deepEqual((await f.read(f.path(taskId))).drafts[1].targets,[]);
 const rejected=await f.create(taskId,1,target);assert.equal(rejected.response.statusCode,403,rejected.response.body);
 assert.equal(f.node.actions.list().length,0);
 await f.grant('calendar.manage');
 const forged=await f.create(taskId,1,{...target,instanceRevision:target.instanceRevision+1});assert.equal(forged.response.statusCode,403);
 const view=await f.read(f.path(taskId)),payload={taskId,expectedRevision:view.revision,index:1,target,scope:f.scope};
 assert.equal((await f.request('POST','/api/assistant/action-commands',{...payload,scope:{kind:'selection',sourceIds:[]}})).statusCode,404);
 assert.equal((await f.request('POST','/api/assistant/action-commands',payload,f.collector)).statusCode,403);
 const created=await f.request('POST','/api/assistant/action-commands',payload);assert.equal(created.statusCode,200,created.body);
 const action=f.node.actions.get(created.json().drafts[1].linked.id);
 const confirmed=await f.request('POST','/api/actions/'+action.id+'/confirm',{version:action.version,event:action.event,target});assert.equal(confirmed.statusCode,200,confirmed.body);
 await until(()=>f.node.actions.get(action.id).status==='succeeded');assert.equal(f.calls.length,1);
});

test('unavailable connectors remain limited and a changed task or withdrawn dependency cannot execute an old proposal',async t=>{
 const f=await assistantActionFixture(t),taskId=await f.start(),{target}=await f.grant('message.send');
 f.setEnabled(false);assert.deepEqual((await f.read(f.path(taskId))).drafts[2].targets,[]);
 assert.equal((await f.create(taskId,2,target)).response.statusCode,403);f.setEnabled(true);
 const created=await f.create(taskId,2,target);assert.equal(created.response.statusCode,200,created.response.body);const id=created.response.json().drafts[2].linked.id;
 const todo=await f.create(taskId,0);assert.equal(todo.response.statusCode,200,todo.response.body);const todoId=todo.response.json().drafts[0].linked.id;
 const pending=f.node.actions.get(id);
 await f.node.sources.upsert('generated-actions-source',{externalId:'meeting',revision:'2',observedAt:'2026-11-02T00:00:00Z',kind:'message',layer:'original',text:'Generated updated evidence'});
 const independentTodos=await f.read('/api/todos?status=open');assert.doesNotMatch(JSON.stringify(independentTodos),/Generated private brief/,'the standalone Todo reader must revalidate its origin before disclosing derived content');
 assert.equal((await f.request('POST','/api/actions/'+id+'/confirm',{version:pending.version,message:pending.message,target})).statusCode,409);
 const stored=String(f.node.store.db.prepare('SELECT json FROM action_proposals WHERE id=?').get(id)!.json);
 assert.doesNotMatch(stored,/Generated private follow-up message/);assert.equal(f.node.actions.get(id).status,'stale');assert.equal(f.calls.length,0);
 assert.doesNotMatch(String(f.node.store.db.prepare('SELECT json FROM todos WHERE id=?').get(todoId)!.json),/Generated private brief/);
 assert.equal((await f.request('POST','/api/assistant/action-commands',created.payload)).statusCode,409);
 const narrowed=await f.request('GET','/api/assistant/matters/'+f.matter.id+'/actions?'+new URLSearchParams({scope:JSON.stringify({kind:'selection',evidenceIds:[]})}));
 assert.equal(narrowed.statusCode,200);assert.deepEqual(narrowed.json(),{items:[]});
 assert.ok(f.node.store.db.prepare('SELECT 1 FROM captures WHERE id=?').get(f.record.id),'version obsolescence is not physical evidence deletion');
});

test('revoking a calendar scope before confirmation and withdrawing task evidence block the existing execution entrypoints',async t=>{
 const f=await assistantActionFixture(t),taskId=await f.start(),{target,grant}=await f.grant('calendar.manage');
 const created=await f.create(taskId,1,target);assert.equal(created.response.statusCode,200,created.response.body);
 const id=created.response.json().drafts[1].linked.id,action=f.node.actions.get(id);
 const revoked=await f.request('POST','/api/action-capability-grants/'+grant.id+'/revoke',{operationId:randomUUID(),expectedRevision:grant.revision});assert.equal(revoked.statusCode,200,revoked.body);
 assert.equal((await f.request('POST','/api/actions/'+id+'/confirm',{version:action.version,event:action.event,target})).statusCode,409);await f.tick();assert.equal(f.calls.length,0);
 const todo=await f.create(taskId,0);assert.equal(todo.response.statusCode,200,todo.response.body);
 const removed=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+f.record.id,headers:f.headers});assert.equal(removed.statusCode,200,removed.body);
 assert.doesNotMatch(JSON.stringify(await f.read('/api/todos?status=open')),/Generated private brief/);
 assert.equal((await f.request('GET',f.path(taskId))).statusCode,409);
 assert.doesNotMatch(String(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(taskId)!.input_json),/Generated meeting/);
});

test('a failed link transaction rolls back the new proposal, and model authority fields cannot become drafts',async t=>{
 const f=await assistantActionFixture(t),taskId=await f.start(),{target}=await f.grant('message.send');
 const revision=f.node.actions.messageProposalRevision();
 f.node.store.db.exec("CREATE TRIGGER generated_link_failure BEFORE INSERT ON assistant_action_links BEGIN SELECT RAISE(ABORT,'Generated link failure'); END");
 const failed=await f.create(taskId,2,target);assert.equal(failed.response.statusCode,500);assert.equal(f.node.actions.list().length,0);
 assert.equal(f.node.actions.messageProposalRevision(),revision,'the existing message proposal revision rolls back with the failed link');
 f.node.store.db.exec('DROP TRIGGER generated_link_failure');const retry=await f.request('POST','/api/assistant/action-commands',failed.payload);assert.equal(retry.statusCode,200,retry.body);assert.equal(f.node.actions.list().length,1);
 assert.equal(f.node.actions.messageProposalRevision(),revision+1);
 const prior=retry.json().drafts[2].linked.id;
 const conflict=await f.request('POST','/api/assistant/action-commands',{...failed.payload,target:{...target,instanceId:'generated-forged'}});assert.equal(conflict.statusCode,409);assert.equal(f.node.actions.list()[0].id,prior);
 const schema=(await import('@mote/shared')).assistantTaskOutputSchema;
 assert.equal(schema.safeParse({answer:'Generated',actions:[{kind:'message.send',message:{conversationId:'generated',text:'Generated'},target,status:'succeeded',evidence:[{id:randomUUID(),quote:actionText}]}]}).success,false);
});
