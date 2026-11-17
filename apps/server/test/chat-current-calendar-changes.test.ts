import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarEvent,currentOwnerCalendarFixture} from './fixtures/current-owner-calendar.js';
import {gate,until} from './fixtures/current-owner-instruction.js';

const updatedEvent={...calendarEvent,start:'2099-09-18T17:00:00Z',end:'2099-09-18T18:00:00Z',location:'Generated changed room'};
const proposal=(kind:string,target:any)=>target?{answer:'The original Action receipt determines the calendar result.',citationIds:[],draft:{goal:'Carry out the current owner calendar instruction',input:'current-action',action:{kind,targetId:target.id,event:kind==='calendar.create'?calendarEvent:kind==='calendar.update'?updatedEvent:target.event}}}:{answer:'The requested original event is not available.',citationIds:[],draft:null};

test('current owner messages update then cancel their exact successful Mote event through the original provider and retain real receipts',{timeout:30000},async t=>{
 let kind='calendar.create';const selected:any[]=[];
 const f=await currentOwnerCalendarFixture(t,({envelope})=>{const target=envelope.ownerActionTargets?.find((target:any)=>target.kind===kind);selected.push(target);return proposal(kind,target);},true);
 const first=await f.post(),created=await f.settled(first.message.id);assert.equal(created.status,'completed');const originalId=created.result!.currentAction!.id;
 await until(()=>f.node.actions.get(originalId).status==='succeeded'?true:undefined,'original provider receipt');const original=f.node.actions.get(originalId);
 kind='calendar.update';const update=await f.post('Move the event I just created to 17:00–18:00 UTC in Generated changed room. Keep its other fields.'),changed=await f.settled(update.message.id);assert.equal(changed.status,'completed',JSON.stringify(changed.error));assert.ok(changed.result!.currentAction,'a real offered original must reach the current Action consumer');
 const updateId=changed.result!.currentAction.id;assert.equal(changed.result!.currentAction.kind,'calendar.update');await until(()=>f.node.actions.get(updateId).status==='succeeded'?true:undefined,'updated provider receipt');
 assert.equal(f.node.actions.get(updateId).related!.actionId,originalId);assert.equal(f.node.actions.get(updateId).externalId,original.externalId);assert.deepEqual(f.node.actions.get(originalId).event,updatedEvent);
 kind='calendar.cancel';const cancel=await f.post('Cancel that same updated event now.'),cancelled=await f.settled(cancel.message.id);assert.equal(cancelled.status,'completed',JSON.stringify(cancelled.error));assert.ok(cancelled.result!.currentAction);const cancelId=cancelled.result!.currentAction.id;assert.equal(cancelled.result!.currentAction.kind,'calendar.cancel');
 await until(()=>f.node.actions.get(cancelId).status==='succeeded'?true:undefined,'cancelled provider receipt');assert.deepEqual(selected[2].event,updatedEvent);assert.equal(f.node.actions.get(originalId).resolution,'cancelled');assert.equal(f.effects.size,0);
 assert.deepEqual(f.calls.map(call=>call.input.kind),['calendar.create','calendar.update','calendar.cancel']);assert.ok(f.calls.slice(1).every(call=>call.input.externalId===original.externalId));assert.equal(new Set(f.calls.map(call=>call.operationId)).size,3);
 const duplicate=await f.api('POST','/api/conversations/messages',cancel.payload);assert.equal(duplicate.statusCode,202,duplicate.body);assert.equal(duplicate.json().id,cancelled.id);await f.restart();assert.equal(f.node.actions.get(updateId).status,'succeeded');assert.equal(f.node.actions.get(cancelId).status,'succeeded');assert.equal(f.calls.length,3);
 const page=await f.api('GET',`/api/conversations/${f.conversationId}?anchor=${cancelled.id}&limit=1`);assert.equal(page.statusCode,200,page.body);assert.deepEqual(page.json().turns.find((turn:{id:string})=>turn.id===cancelled.id).result.currentAction,{id:cancelId,kind:'calendar.cancel'});
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,0);
});

test('a real original-event version change after the Host offer rejects the late owner update before any provider write',{timeout:30000},async t=>{
 const entered=gate(),release=gate();t.after(()=>release.release());let kind='calendar.create',offered:any;
 const f=await currentOwnerCalendarFixture(t,async({envelope})=>{const target=envelope.ownerActionTargets?.find((target:any)=>target.kind===kind);if(kind==='calendar.update'){offered=target;entered.release();await release.promise;}return proposal(kind,target);},true);
 const first=await f.post(),created=await f.settled(first.message.id),originalId=created.result!.currentAction!.id;await until(()=>f.node.actions.get(originalId).status==='succeeded'?true:undefined,'original success');
 kind='calendar.update';const accepted=await f.post('Move the event I just created to 17:00–18:00 UTC in Generated changed room.');await entered.promise;assert.ok(offered,'the model received the original immutable offer');
 f.node.store.db.prepare("UPDATE action_proposals SET json=json_set(json,'$.version',json_extract(json,'$.version')+1) WHERE id=?").run(originalId);release.release();
 const rejected=await f.settled(accepted.message.id);assert.equal(rejected.status,'failed');assert.equal(rejected.result,undefined);assert.equal(f.calls.length,1);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n,1);assert.deepEqual(f.node.actions.get(originalId).event,calendarEvent);
});
