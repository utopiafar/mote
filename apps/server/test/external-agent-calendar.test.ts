import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {currentOwnerCalendarFixture,calendarEvent,calendarInstruction} from './fixtures/current-owner-calendar.js';
import {gate,until} from './fixtures/current-owner-instruction.js';

const tool='delegation_calendar_propose';
const declared=(request:any)=>Boolean(request.tools?.some((entry:any)=>entry.function?.name===tool));

test('the real external Agent SDK proposes one current-owner calendar create before the existing Host commit',{timeout:30000},async t=>{
 const finish=gate();t.after(()=>finish.release());let offered=false,called=false,returned=false,toolResult='';
 const f=await currentOwnerCalendarFixture(t,async({request,envelope})=>{
  offered=declared(request);
  if(!offered){returned=true;return{answer:'Generated no authorized Action tool.',citationIds:[],draft:null};}
  if(!called){called=true;return{tool:{name:tool,arguments:{proposalJson:JSON.stringify(f.actionProposal(envelope).draft)}}};}
  toolResult=JSON.stringify(request.messages.filter((message:any)=>message.role==='tool'));returned=true;await finish.promise;
  return{answer:'Generated calendar proposal submitted; the original Action receipt reports its outcome.',citationIds:[],draft:null};
 });
 const submitted=await f.post();await until(()=>returned||f.node.conversations.message(submitted.message.id).status==='failed'?true:undefined,'real external SDK tool result');
 assert.equal(offered,true,'the actual runtime must receive the Host-bound proposal tool: '+JSON.stringify(f.node.conversations.message(submitted.message.id)));assert.equal(called,true);assert.match(toolResult,/proposed/);
 assert.equal(f.calls.length,0,'a tool proposal alone cannot execute the connector');assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n,0,'the query has not committed an authorized Action');
 finish.release();const message=await f.settled(submitted.message.id);assert.equal(message.status,'completed');assert.ok(message.result?.currentAction);
 const reference=message.result.currentAction;await until(()=>f.node.actions.get(reference.id).status==='succeeded'?true:undefined,'original authorized Action effect');
 assert.equal(f.calls.length,1);assert.equal(f.effects.size,1);assert.deepEqual(f.calls[0].input.event,calendarEvent);
 assert.deepEqual(f.node.actions.get(reference.id).ownerInstruction,{conversationId:f.conversationId,messageId:submitted.message.id});
 const page=await f.api('GET',`/api/conversations/${f.conversationId}?anchor=${submitted.message.id}&limit=1`);assert.equal(page.statusCode,200,page.body);assert.deepEqual(page.json().turns.find((turn:any)=>turn.id===submitted.message.id).result.currentAction,reference);
});

test('the real external Agent SDK has no calendar proposal authority without a bound current owner message',{timeout:30000},async t=>{
 let attempted=false,offered=true,rejection='';
 const f=await currentOwnerCalendarFixture(t,({request})=>{
  offered=declared(request);if(!attempted){attempted=true;return{tool:{name:tool,arguments:{proposalJson:JSON.stringify({goal:'Generated unauthorized attempt',input:'current-action',action:{kind:'calendar.create',event:calendarEvent,targetId:randomUUID()}})}}};}
  rejection=JSON.stringify(request.messages.filter((message:any)=>message.role==='tool'));return{answer:'Generated no authorized Action.',citationIds:[],draft:null};
 });
 const id=randomUUID(),admitted=await f.api('POST','/api/query-runs',{id,input:{question:calendarInstruction}});assert.equal(admitted.statusCode,202,admitted.body);
 const run=await until(()=>{const value=f.node.queryRuns.get(id);return ['completed','failed','cancelled'].includes(value.status)?value:undefined;},'standalone SDK query without a current owner message');assert.equal(run.status,'completed');
 assert.equal(attempted,true);assert.equal(offered,false,'a standalone Agent run receives no owner Action channel');assert.match(rejection,/Only Host-granted tools are available/);
 assert.ok(run.conversationId&&run.turnId);const page=await f.api('GET',`/api/conversations/${run.conversationId}?anchor=${run.turnId}&limit=1`);assert.equal(page.statusCode,200,page.body);const turn=page.json().turns.find((value:any)=>value.id===run.turnId);assert.ok(turn);assert.equal(turn.result.currentAction,undefined);
 assert.equal(f.calls.length,0);assert.equal(f.effects.size,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n,0);
});

test('the real external Agent SDK cannot substitute an unoffered calendar target',{timeout:30000},async t=>{
 let called=false,offered=false;
 const f=await currentOwnerCalendarFixture(t,({request,envelope})=>{
  offered=declared(request);if(!called){called=true;const proposal=f.actionProposal(envelope).draft;proposal.action.targetId=randomUUID();return{tool:{name:tool,arguments:{proposalJson:JSON.stringify(proposal)}}};}
  return{answer:'Generated rejected calendar proposal.',citationIds:[],draft:null};
 });
 const submitted=await f.post();const message=await f.settled(submitted.message.id);
 assert.equal(offered,true,JSON.stringify(message));assert.equal(called,true);assert.equal(message.status,'failed');assert.equal(message.result,undefined);assert.equal(f.calls.length,0);assert.equal(f.effects.size,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n,0);
});
