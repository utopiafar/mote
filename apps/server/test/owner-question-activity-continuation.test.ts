import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {Operations} from '../src/operations.js';
import {ActivityProjection} from '../src/activity.js';
import {randomUUID} from 'node:crypto';
import {assistantQuestionFixture,ownerAnswer,until} from './fixtures/assistant-owner-question.js';
import {TaskRecords} from '../src/task-records.js';

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

test('an assistant task waits in the existing owner inbox and two clients can resume it only once',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question();
 const waiting=await f.read(taskId);assert.equal(waiting.task.state,'needs_input');assert.equal(waiting.result,undefined);
 assert.equal(question.workId,question.operationId);assert.equal(question.messages.length,1);assert.equal(f.continued,0,'an unanswered question never implies consent');
 assert.equal(question.evidence[0].ref,'capture:'+f.evidenceId,'the host replaces the model locator with the authorized original ID');
 const body={requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'};
 const path='/api/owner-questions/'+question.id+'/reply';
 const replies=await Promise.all([f.api('POST',path,body),f.api('POST',path,{...body,requestId:randomUUID()})]);
 assert.deepEqual(replies.map(reply=>reply.statusCode).sort(),[200,409]);
 const accepted=replies.find(reply=>reply.statusCode===200)!.json();assert.equal(accepted.state,'answered');
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(taskId)?.state==='succeeded');
 const result=await f.read(taskId);assert.equal(result.task.id,taskId);assert.equal(result.result.answer,'Generated continued task result');
 // Replay the actual winner's durable request; both clients used the same
 // authored choice, but only one request ID was accepted.
 const receipt=f.node.store.db.prepare('SELECT request_id FROM owner_question_replies WHERE question_id=?').get(question.id)!;
 const repeated=await f.api('POST',path,{...body,requestId:String(receipt.request_id)});assert.equal(repeated.statusCode,200,repeated.body);
 assert.equal((await f.api('POST',path,{...body,requestId:randomUUID()})).statusCode,409);
 assert.equal(f.continued,1);assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,2);
 assert.equal((await f.questions()).length,1);
});

test('a stored assistant reply resumes its original task after restart without another admission',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question();f.hold();
 const body={requestId:randomUUID(),expectedRevision:question.revision,action:'answer',answer:'  '+ownerAnswer+'\n'};
 const path='/api/owner-questions/'+question.id+'/reply',response=await f.api('POST',path,body);assert.equal(response.statusCode,200,response.body);
 await until(()=>f.continued===1);
 const saved=String(f.node.store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(question.id)!.json);
 assert.match(saved,/aes:/);assert.doesNotMatch(saved,/exact owner answer|Which generated option/);
 await f.restart();
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(taskId)?.state==='succeeded');
 const result=await f.read(taskId);assert.equal(result.task.id,taskId);assert.equal(result.result.answer,'Generated continued task result');
 const current=(await f.api('GET','/api/owner-questions/'+question.id)).json();assert.equal(current.state,'answered');assert.equal(current.messages.at(-1).text,body.answer,'literal owner input survives the vault reopen');
 assert.match(f.wire,/ownerClarificationReply/);assert.match(f.wire,/exact owner answer/);
 const repeated=await f.api('POST',path,body);assert.equal(repeated.statusCode,200,repeated.body);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,2,'the interrupted read-only attempt reuses the stored continuation');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM owner_question_replies WHERE question_id=?').get(question.id)!.n,1);
});

test('defer and unknown never supply consent, and an old question revision cannot resume the task',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question(),path='/api/owner-questions/'+question.id+'/reply';
 const deferred=await f.api('POST',path,{requestId:randomUUID(),expectedRevision:question.revision,action:'defer'});assert.equal(deferred.statusCode,200,deferred.body);assert.equal(deferred.json().state,'deferred');
 assert.equal((await f.api('POST',path,{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'})).statusCode,409);
 const unknown=await f.api('POST',path,{requestId:randomUUID(),expectedRevision:deferred.json().revision,action:'unknown'});assert.equal(unknown.statusCode,200,unknown.body);assert.equal(unknown.json().state,'closed');
 assert.equal((await f.read(taskId)).task.state,'needs_input');assert.equal(f.continued,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch'").get()!.n,1);
 const resumed=await f.api('POST',path,{requestId:randomUUID(),expectedRevision:unknown.json().revision,action:'answer',choiceId:'first'});assert.equal(resumed.statusCode,200,resumed.body);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(taskId)?.state==='succeeded');assert.equal(f.continued,1);
});

test('cancelling the current assistant task erases its question and rejects late answers',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question(),tasks=new TaskRecords(f.node.store),current=tasks.get(taskId);
 tasks.setState(taskId,current.revision,'cancelled');
 const saved=String(f.node.store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(question.id)!.json);assert.doesNotMatch(saved,/aes:|Which generated option/,'cancellation scrubs prose without waiting for a question read');
 const retired=(await f.api('GET','/api/owner-questions/'+question.id)).json();assert.equal(retired.state,'obsolete');assert.deepEqual(retired.messages,[]);
 assert.equal((await f.read(taskId)).task.state,'cancelled');
 assert.equal((await f.api('POST','/api/owner-questions/'+question.id+'/reply',{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'})).statusCode,409);
 assert.equal(f.continued,0);
});

test('the question is pinned to the blocked assistant task revision',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question(),tasks=new TaskRecords(f.node.store),current=tasks.get(taskId);
 tasks.setState(taskId,current.revision,'blocked');
 const answer=await f.api('POST','/api/owner-questions/'+question.id+'/reply',{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'});
 assert.equal(answer.statusCode,409,answer.body);assert.equal((await f.questions())[0].state,'obsolete');assert.equal(f.continued,0);
});

test('withdrawing evidence while an answered task runs erases the question and prevents a late result',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question();f.hold();
 const body={requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'};
 assert.equal((await f.api('POST','/api/owner-questions/'+question.id+'/reply',body)).statusCode,200);await until(()=>f.continued===1);
 const removed=await f.api('DELETE','/api/captures/'+f.evidenceId);assert.equal(removed.statusCode,200,removed.body);
 f.release();
 const steps=f.node.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind='batch.item'").all(question.operationId);
 await until(()=>steps.every(step=>!f.node.executor.isActiveStep(String(step.id))));
 const view=await f.read(taskId);assert.equal(view.task.state,'stale');assert.equal(view.result,undefined);
 const retired=(await f.api('GET','/api/owner-questions/'+question.id)).json();assert.equal(retired.state,'obsolete');assert.deepEqual(retired.messages,[]);assert.equal(retired.continuationId,undefined);
 const work=f.node.store.db.prepare('SELECT input_json,result_json FROM task_records WHERE operation_id=?').all(question.operationId);
 assert.ok(work.every(row=>row.input_json===null&&row.result_json===null));
 assert.equal((await f.api('POST','/api/owner-questions/'+question.id+'/reply',body)).json().state,'obsolete','a replay reports current retirement rather than reviving the saved answer');
});

test('a failed assistant continuation admission rolls back the answer receipt and task transition together',async t=>{
 const f=await assistantQuestionFixture(t),taskId=await f.start(),question=await f.question(),before=await f.read(taskId);
 const body={requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'},path='/api/owner-questions/'+question.id+'/reply';
 f.node.store.db.exec("CREATE TEMP TRIGGER generated_continuation_failure BEFORE INSERT ON task_records WHEN new.kind='batch' BEGIN SELECT RAISE(ABORT,'generated continuation admission failed'); END;");
 const failed=await f.api('POST',path,body);assert.equal(failed.statusCode,500,failed.body);
 assert.equal((await f.read(taskId)).task.revision,before.task.revision);assert.equal((await f.read(taskId)).task.state,'needs_input');
 assert.equal((await f.questions())[0].revision,question.revision);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM owner_question_replies WHERE question_id=?').get(question.id)!.n,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch.item'").get()!.n,1);
 f.node.store.db.exec('DROP TRIGGER generated_continuation_failure');
 const retried=await f.api('POST',path,body);assert.equal(retried.statusCode,200,retried.body);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(taskId)?.state==='succeeded');assert.equal(f.continued,1);
});
