import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {taskSteeringFixture as fixture,until} from './fixtures/assistant-task-steering.js';

test('owner HTTP adjusts a real accepted assistant task through its own native turn and preserves the task/result conversation link',{timeout:30000},async t=>{
 const f=await fixture(t),original=await f.start();assert.equal(f.task(original.taskId).state,'running');
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');await until(()=>f.rpc().find(row=>row.method==='turn/steer'),'formal task native steering');
 const received=await f.settle(amendment.message.id);assert.equal(received.status,'completed',JSON.stringify(received));
 const repeated=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:f.headers,payload:amendment.payload});assert.equal(repeated.statusCode,202,repeated.body);assert.equal(repeated.json().id,amendment.message.id);
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'the original formal task result');
 const view=f.node.assistantTasks.get(original.taskId,original.draft.scope);assert.equal(view.task.id,original.taskId);assert.match(view.result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);
 assert.equal(received.taskSteering?.targetTaskId,original.taskId);assert.equal(received.taskSteering?.state,'accepted');
 const publicReceipt=await f.node.app.inject({url:`/api/conversations/${f.id}/messages/${amendment.message.id}`,headers:f.headers});assert.equal(publicReceipt.statusCode,200,publicReceipt.body);const publicSteering=publicReceipt.json().taskSteering;
 assert.deepEqual(Object.keys(publicSteering).sort(),['origin','scope','state','targetOperationId','targetRevision','targetTaskId'].sort());assert.deepEqual(publicSteering.scope,original.draft.scope);assert.deepEqual(publicSteering.origin,{conversationId:f.id,turnId:original.turn.id});
 const history=f.node.conversations.get(f.id).turns.find(turn=>turn.id===amendment.message.id)!.taskSteering!;assert.deepEqual(history,publicSteering,'native turn/step/hash fences are private in both receipt and history projections');
 const linked=f.node.assistantTasks.byTurn(f.id,original.turn.id,original.draft.scope);assert.equal(linked.items.length,1);assert.equal(linked.items[0].task.id,original.taskId);
 const delivery=f.rpc().filter(row=>row.method==='turn/steer');assert.equal(delivery.length,1);assert.equal(f.rpc().filter(row=>row.pid===delivery[0].pid&&row.method==='turn/start').length,1);
});

test('cancelling an acknowledged Task amendment preserves the original Task and source grant while independent input answers',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('hold-terminal');const original=await f.start(),before=f.task(original.taskId),firstStep=f.node.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind='batch.item'").get(before.operation_id)!;
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');assert.equal((await f.settle(amendment.message.id)).taskSteering?.state,'accepted');
 const independent=await f.post('GENERATED-UNRELATED');assert.equal((await f.settle(independent.message.id)).status,'completed');assert.equal(f.task(original.taskId).state,'running');
 const cancel=await f.cancel(amendment.message.id);assert.equal(cancel.statusCode,200,cancel.body);assert.equal(cancel.json().taskSteering.state,'cancelled');assert.notEqual(f.task(original.taskId).state,'cancelled');
 f.release();await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'original Task after withdrawing the amendment');
 const view=f.node.assistantTasks.get(original.taskId,original.draft.scope);assert.match(view.result!.answer,/original task/);assert.doesNotMatch(view.result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);
 const steps=f.node.store.db.prepare("SELECT id,state FROM execution_steps WHERE operation_id=? AND kind='batch.item' ORDER BY rowid").all(before.operation_id);assert.equal(steps.length,2);assert.deepEqual(steps.map(row=>row.state),['cancelled','succeeded']);
 assert.equal(f.node.modelAuthorization.stepAuthority(String(steps[1].id)),f.node.modelAuthorization.stepAuthority(String(firstStep.id)),'the replacement inherits the original Task authority, never the amendment query grant');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,1);assert.ok(Number(f.task(original.taskId).revision)>Number(before.revision));
 await f.restart();assert.equal(f.node.conversations.message(amendment.message.id).status,'cancelled');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);
});

test('a real Task accepted-write failure persists unknown without resending, and explicit amendment cancellation can resume the original goal',{timeout:30000},async t=>{
 const f=await fixture(t),original=await f.start();f.node.store.db.exec("CREATE TRIGGER generated_task_ack_failure BEFORE UPDATE ON conversation_turns WHEN json_extract(NEW.json,'$.taskSteering.state')='accepted' BEGIN SELECT RAISE(ABORT,'generated task receipt write failed'); END");
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION'),unknown=await f.settle(amendment.message.id);assert.equal(unknown.status,'failed');assert.equal(unknown.taskSteering?.state,'unknown');
 await until(()=>f.task(original.taskId).state!=='running'?true:undefined,'Task stopped after failed receipt');assert.notEqual(f.task(original.taskId).state,'succeeded');
 f.node.store.db.exec('DROP TRIGGER generated_task_ack_failure');await f.restart();
 const duplicate=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:f.headers,payload:amendment.payload});assert.equal(duplicate.statusCode,202,duplicate.body);assert.equal(duplicate.json().taskSteering.state,'unknown');
 const independent=await f.post('GENERATED-UNRELATED',randomUUID(),{kind:'selection',evidenceIds:[]});assert.equal((await f.settle(independent.message.id)).status,'completed');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);
 const cancelled=await f.cancel(amendment.message.id);assert.equal(cancelled.statusCode,200,cancelled.body);f.release();
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'same Task resuming without the unknown amendment');
 assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/original task/);assert.equal(f.node.conversations.message(amendment.message.id).status,'cancelled');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);
});

test('Task restart consumes acknowledged owner text from its durable receipt under the same persisted model pin',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('hold-terminal');const original=await f.start(),pin=f.node.store.db.prepare('SELECT * FROM assistant_task_runtime WHERE task_id=?').get(original.taskId)!;
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');assert.equal((await f.settle(amendment.message.id)).taskSteering?.state,'accepted');await f.restart();
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'restored Task consuming its accepted owner amendment');
 assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);assert.deepEqual(f.node.store.db.prepare('SELECT * FROM assistant_task_runtime WHERE task_id=?').get(original.taskId),pin);
 assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);const restored=f.rpc().filter(row=>row.method==='turn/start').at(-1),envelope=JSON.parse(restored.params.input[0].text);assert.deepEqual(envelope.untrustedTaskContext.ownerAmendments,[{messageId:amendment.message.id,question:'GENERATED-FORMAL-TASK-CORRECTION'}]);
});

for(const restriction of ['scope','model'] as const)test(`a formal Task outside the new ${restriction} cannot be exposed or adjusted`,{timeout:30000},async t=>{
 const f=await fixture(t),original=await f.start(),before=f.rpc().filter(row=>row.method==='turn/start').length;
 const separate=await f.post('GENERATED-UNRELATED',randomUUID(),restriction==='scope'?{kind:'selection',evidenceIds:[]}:f.scope,restriction==='model'?{modelOverride:'generated-other-model'}:{});
 assert.equal((await f.settle(separate.message.id)).status,'completed');assert.equal(f.node.conversations.message(separate.message.id).taskSteering,undefined);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);assert.equal(f.rpc().filter(row=>row.method==='turn/start').length,before+1,'no eligible target adds no disposition model call');
 const last=f.rpc().filter(row=>row.method==='turn/start').at(-1);assert.doesNotMatch(last.params.input[0].text,/Generated formal task goal/);assert.equal(f.task(original.taskId).state,'running');f.release();
});

test('a waiting owner-question Task resumes through a message continuation without reusing the old question revision',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('question');const original=await f.start();await until(()=>f.task(original.taskId).state==='blocked'?true:undefined,'Task waiting for owner input');
 const questions=await f.node.app.inject({url:'/api/owner-questions?'+new URLSearchParams({operationId:String(f.task(original.taskId).operation_id)}),headers:f.headers});assert.equal(questions.statusCode,200,questions.body);const [question]=questions.json().items;assert.ok(question);
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');const completed=await f.settle(amendment.message.id);assert.equal(completed.status,'completed',JSON.stringify(completed));assert.equal(completed.taskSteering?.state,'continuation');
 assert.equal(f.task(original.taskId).state,'succeeded');assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);
 const stale=await f.node.app.inject({method:'POST',url:'/api/owner-questions/'+question.id+'/reply',headers:f.headers,payload:{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',answer:'Generated stale owner-question reply'}});assert.equal(stale.statusCode,409,stale.body);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE operation_id=? AND kind='batch'").get(f.task(original.taskId).operation_id)!.n,2,'a stale question cannot enqueue another continuation');
});

test('unsupported DSH Task steering uses the same Task and inherited authority across a persisted continuation and restart',{timeout:30000},async t=>{
 const f=await fixture(t,{runtime:'dsh'});f.setMode('hold-continuation');const original=await f.start(),operationId=f.task(original.taskId).operation_id;
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');await until(()=>f.node.conversations.message(amendment.message.id).taskSteering?.state==='continuation'?true:undefined,'durable Task continuation');
 await until(()=>f.requests.some(row=>JSON.stringify(row).includes('ownerAmendments'))?true:undefined,'the actual DSH continuation reading the owner amendment');await f.restart();f.release();
 const completed=await f.settle(amendment.message.id);assert.equal(completed.status,'completed',JSON.stringify(completed));assert.equal(completed.taskSteering?.state,'continuation');assert.equal(f.task(original.taskId).state,'succeeded');assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);
 const steps=f.node.store.db.prepare("SELECT id,state FROM execution_steps WHERE operation_id=? AND kind='batch.item' ORDER BY rowid").all(operationId);assert.deepEqual(steps.map(row=>row.state),['cancelled','succeeded']);assert.equal(f.node.modelAuthorization.stepAuthority(String(steps[0].id)),f.node.modelAuthorization.stepAuthority(String(steps[1].id)));assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);
});


test('an acknowledged Task restart keeps its actual saved profile when the owner changes the default profile',{timeout:30000},async t=>{
 const f=await fixture(t);await f.copyProfile('generated-task-pin');await f.copyProfile('generated-new-default');await f.selectProfile('generated-task-pin');f.setMode('hold-terminal');
 const original=await f.start(),amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');assert.equal((await f.settle(amendment.message.id)).taskSteering?.state,'accepted');
 const saved=f.node.store.db.prepare('SELECT * FROM assistant_task_runtime WHERE task_id=?').get(original.taskId)!;assert.equal(saved.profile_id,'generated-task-pin');
 await f.selectProfile('generated-new-default');await f.restart();await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'Task restored with its saved profile instead of the new default');
 assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);assert.deepEqual(f.node.store.db.prepare('SELECT * FROM assistant_task_runtime WHERE task_id=?').get(original.taskId),saved);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);
});

test('deleting the actually selected Task profile before the native ACK rejects that amendment and late result',{timeout:30000},async t=>{
 const f=await fixture(t);const initial=(await f.models()).defaults.chat;await f.copyProfile('generated-task-removed');await f.selectProfile('generated-task-removed');f.setMode('hold-ack');
 const original=await f.start(),amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');await until(()=>f.rpc().some(row=>row.method==='turn/steer')?true:undefined,'Task steer sent before changing its actual model selection');
 await f.selectProfile(initial);await f.removeProfile('generated-task-removed');f.releaseAck();const failed=await f.settle(amendment.message.id);assert.equal(failed.status,'failed');assert.equal(failed.taskSteering?.state,'unknown');
 await until(()=>f.task(original.taskId).state!=='running'?true:undefined,'removed-profile Task stopped');assert.notEqual(f.task(original.taskId).state,'succeeded');assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(original.taskId)!.result_json,null);
 const separate=await f.post('GENERATED-UNRELATED');assert.equal((await f.settle(separate.message.id)).status,'completed');await f.restart();assert.notEqual(f.task(original.taskId).state,'succeeded');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);
});

test('a started legacy Task without a selection pin still recovers normally but is not a steering candidate',{timeout:30000},async t=>{
 const f=await fixture(t),original=await f.start();f.node.store.db.prepare('DELETE FROM assistant_task_runtime WHERE task_id=?').run(original.taskId);await f.restart();
 const before=f.rpc().filter(row=>row.method==='turn/start').length,other=await f.post('GENERATED-UNRELATED');assert.equal((await f.settle(other.message.id)).status,'completed');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);
 assert.equal(f.node.store.db.prepare('SELECT * FROM assistant_task_runtime WHERE task_id=?').get(original.taskId),undefined);assert.ok(f.rpc().filter(row=>row.method==='turn/start').length>before);f.release();
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'legacy Task recovery without inventing an old model selection');assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/original task/);
});

test('an accepted Task amendment with a missing persisted selection cannot invent a profile during restart',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('hold-terminal');const original=await f.start(),amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');assert.equal((await f.settle(amendment.message.id)).taskSteering?.state,'accepted');
 f.node.store.db.prepare('DELETE FROM assistant_task_runtime WHERE task_id=?').run(original.taskId);const before=f.rpc().filter(row=>row.method==='turn/start').length;await f.restart();
 await until(()=>f.task(original.taskId).state==='blocked'?true:undefined,'Task refusing an unknown prior model selection');const failed=f.node.store.db.prepare("SELECT error FROM execution_steps WHERE operation_id=? AND kind='batch.item'").get(f.task(original.taskId).operation_id)!;assert.equal(failed.error,'assistant_task_selection_unavailable');
 assert.equal(f.rpc().filter(row=>row.method==='turn/start').length,before);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);assert.equal(f.node.conversations.message(amendment.message.id).taskSteering?.state,'accepted');
});

test('cancelling a waiting unsupported-runtime amendment preserves the Task and fences its old continuation result',{timeout:30000},async t=>{
 const f=await fixture(t,{runtime:'dsh'});f.setMode('hold-continuation');const original=await f.start(),amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');
 await until(()=>f.requests.some(row=>JSON.stringify(row).includes('ownerAmendments'))?true:undefined,'DSH continuation receiving its persisted owner amendment');const cancelled=await f.cancel(amendment.message.id);assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().taskSteering.state,'cancelled');assert.notEqual(f.task(original.taskId).state,'cancelled');f.release();
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'original Task after cancelling its waiting amendment');assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/original task/);assert.doesNotMatch(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/GENERATED-FORMAL-TASK-CORRECTION/);
 assert.deepEqual(f.node.store.db.prepare("SELECT state FROM execution_steps WHERE operation_id=? AND kind='batch.item' ORDER BY rowid").all(f.task(original.taskId).operation_id).map(row=>row.state),['cancelled','cancelled','succeeded']);
});

test('withdrawal of the original Task evidence before a native ACK rejects both the amendment and late Task result',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('hold-ack');const original=await f.start(),amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');await until(()=>f.rpc().some(row=>row.method==='turn/steer')?true:undefined,'Task native request awaiting ACK');
 const deleted=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+f.evidenceId,headers:f.headers});assert.equal(deleted.statusCode,200,deleted.body);f.releaseAck();const failed=await f.settle(amendment.message.id);assert.equal(failed.status,'failed');assert.notEqual(failed.taskSteering?.state,'accepted');
 await until(()=>f.task(original.taskId).state!=='running'?true:undefined,'Task stopped after its original was withdrawn');assert.notEqual(f.task(original.taskId).state,'succeeded');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);const retired=f.node.assistantTasks.get(original.taskId,original.draft.scope);assert.equal(retired.task.state,'stale');assert.equal(retired.result,undefined);
});


test('a late semantic disposition cannot adjust a replacement attempt of the same Task after exact amendment cancellation',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('hold-terminal');const original=await f.start(),first=await f.post('GENERATED-FORMAL-TASK-CORRECTION');assert.equal((await f.settle(first.message.id)).taskSteering?.state,'accepted');f.setMode('hold-route');const before=f.rpc().filter(row=>row.method==='turn/start').length;
 const late=await f.post('GENERATED-SECOND-TASK-CORRECTION');await until(()=>f.rpc().filter(row=>row.method==='turn/start').length>before?true:undefined,'classification pinned to the original Task batch');const prior=f.task(original.taskId),cancelled=await f.cancel(first.message.id);assert.equal(cancelled.statusCode,200,cancelled.body);assert.ok(Number(f.task(original.taskId).revision)>Number(prior.revision));
 f.releaseRoute();const rejected=await f.settle(late.message.id);assert.equal(rejected.status,'failed');assert.equal(rejected.taskSteering,undefined);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1,'the old selected batch cannot steer the new same-Task runtime');f.release();
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'original Task without either withdrawn or late amendment');assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/original task/);
});


test('a model-selected Task outside the actual Host candidate identities cannot receive owner text',{timeout:30000},async t=>{
 const f=await fixture(t),original=await f.start();f.setMode('unlisted-task');const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION'),failed=await f.settle(amendment.message.id);
 assert.equal(failed.status,'failed');assert.equal(failed.taskSteering,undefined);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);assert.equal(f.task(original.taskId).state,'running');f.release();
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'original Task after rejecting an unlisted target identity');assert.match(f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer,/original task/);
});


test('withdrawing a Task supplement keeps the previously answered owner question in the real replacement attempt',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('question');const original=await f.start();await until(()=>f.task(original.taskId).state==='blocked'?true:undefined,'Task waiting for its original owner question');
 const page=await f.node.app.inject({url:'/api/owner-questions?'+new URLSearchParams({operationId:String(f.task(original.taskId).operation_id)}),headers:f.headers});assert.equal(page.statusCode,200,page.body);const [question]=page.json().items;assert.ok(question);f.setMode('hold-terminal');
 const reply=await f.node.app.inject({method:'POST',url:'/api/owner-questions/'+question.id+'/reply',headers:f.headers,payload:{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',answer:'GENERATED-PREVIOUS-OWNER-CHOICE'}});assert.equal(reply.statusCode,200,reply.body);
 await until(()=>f.rpc().some(row=>row.method==='turn/start'&&row.params.input[0].text.includes('ownerClarificationReply'))?true:undefined,'the normal Task continuation reading its owner answer');
 const amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');assert.equal((await f.settle(amendment.message.id)).taskSteering?.state,'accepted');const cancelled=await f.cancel(amendment.message.id);assert.equal(cancelled.statusCode,200,cancelled.body);f.release();
 await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'Task retaining the prior owner choice after cancelling a later amendment');const result=f.node.assistantTasks.get(original.taskId,original.draft.scope).result!;assert.match(result.answer,/GENERATED-PREVIOUS-OWNER-CHOICE/);assert.doesNotMatch(result.answer,/GENERATED-FORMAL-TASK-CORRECTION/);assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);
});


test('restoring accepted Task amendments preserves the original batch context byte budget without truncating owner messages',{timeout:30000},async t=>{
 const f=await fixture(t);f.setMode('hold-terminal');const original=await f.start(),question='GENERATED-BOUNDED-OWNER-AMENDMENT '+ 'x'.repeat(7560),ids:string[]=[];
 for(let index=0;index<7;index++){const amendment=await f.post(question+' '+index),accepted=await f.settle(amendment.message.id);assert.equal(accepted.status,'completed');assert.equal(accepted.taskSteering?.state,'accepted');ids.push(amendment.message.id);}
 assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,7);const before=f.rpc().filter(row=>row.method==='turn/start').length;await f.restart();
 await until(()=>f.task(original.taskId).state!=='running'&&f.task(original.taskId).state!=='waiting'?true:undefined,'bounded Task reconstruction');const step=f.node.store.db.prepare("SELECT error FROM execution_steps WHERE operation_id=? AND kind='batch.item'").get(f.task(original.taskId).operation_id)!;
 assert.equal(f.task(original.taskId).state,'blocked');assert.equal(step.error,'assistant_task_context_budget');assert.equal(f.rpc().filter(row=>row.method==='turn/start').length,before,'oversized combined owner input is blocked before another native model call');
 assert.deepEqual(ids.map(id=>f.node.conversations.message(id).question),ids.map((_,index)=>question+' '+index));assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,7,'accepted text is never silently truncated or resent');
 const cancelled=await f.cancel(ids[0]);assert.equal(cancelled.statusCode,200,cancelled.body);await until(()=>f.task(original.taskId).state==='succeeded'?true:undefined,'the same Task recovering after explicit cancellation reduces its accepted context');assert.equal(f.node.conversations.message(ids[0]).status,'cancelled');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,7);const output=f.node.assistantTasks.get(original.taskId,original.draft.scope).result!.answer;assert.ok(output.includes(question+' 6'));assert.ok(!output.includes(question+' 0'));
});


for(const changed of [false,true])test(`a newly queued Task waits for its own actual model selection before amendment delivery (${changed?'different selection rejected':'same selection steered'})`,{timeout:30000},async t=>{
 const f=await fixture(t);if(changed)await f.copyProfile('generated-queued-model');const first=await f.start(),queued=await f.start('GENERATED-QUEUED-DRAFT-REQUEST');assert.notEqual(queued.taskId,first.taskId);assert.equal(f.task(queued.taskId).state,'waiting');assert.equal(f.node.store.db.prepare('SELECT profile_id FROM assistant_task_runtime WHERE task_id=?').get(queued.taskId)!.profile_id,null);f.setTargetTask(queued.taskId);
 let amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');await until(()=>f.node.store.db.prepare("SELECT 1 FROM execution_steps WHERE error='assistant_task_selection_pending' AND state='waiting'").get()?true:undefined,'the related message waiting without choosing the queued Task model');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);assert.equal(f.node.conversations.message(amendment.message.id).taskSteering,undefined);
 if(!changed){const cancelled=await f.cancel(amendment.message.id);assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().status,'cancelled');assert.equal(f.task(queued.taskId).state,'waiting');const repeated=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:f.headers,payload:amendment.payload});assert.equal(repeated.statusCode,202,repeated.body);assert.equal(repeated.json().status,'cancelled');amendment=await f.post('GENERATED-FORMAL-TASK-CORRECTION');await until(()=>f.node.store.db.prepare("SELECT 1 FROM execution_steps WHERE error='assistant_task_selection_pending' AND state='waiting'").get()?true:undefined,'the replacement owner input waiting on the same queued Task');}
 const independent=await f.post('GENERATED-UNRELATED');assert.equal((await f.settle(independent.message.id)).status,'completed');assert.equal(f.task(first.taskId).state,'running');assert.equal(f.task(queued.taskId).state,'waiting');if(changed)await f.selectProfile('generated-queued-model');f.release();
 const result=await f.settle(amendment.message.id);if(changed){assert.equal(result.status,'failed');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,0);assert.equal(f.node.store.db.prepare('SELECT profile_id FROM assistant_task_runtime WHERE task_id=?').get(queued.taskId)!.profile_id,'generated-queued-model');f.releaseQueued();}else{assert.equal(result.status,'completed');assert.equal(result.taskSteering?.targetTaskId,queued.taskId);assert.equal(result.taskSteering?.state,'accepted');assert.equal(f.rpc().filter(row=>row.method==='turn/steer').length,1);}
 await until(()=>f.task(queued.taskId).state==='succeeded'?true:undefined,'the same queued Task completing once');assert.equal(f.task(first.taskId).state,'succeeded');const answer=f.node.assistantTasks.get(queued.taskId,queued.draft.scope).result!.answer;assert.equal(answer.includes('GENERATED-FORMAL-TASK-CORRECTION'),!changed);assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE operation_id=? AND kind='batch.item'").get(f.task(queued.taskId).operation_id)!.n,1,'waiting never replaces the queued Task batch or borrows the message model grant');
});
