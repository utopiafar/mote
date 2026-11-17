import test from 'node:test';
import assert from 'node:assert/strict';
import {currentInstructionFixture} from './fixtures/current-owner-instruction.js';

const recording=' \n今天午休在楼下散步了十分钟。\t ';
const acknowledgement='记下了，今天午休散步了十分钟。';

test('a persisted owner record receives the model brief acknowledgement without creating another product and survives replay and restart',{timeout:30000},async t=>{
 const f=await currentInstructionFixture(t,()=>({answer:acknowledgement,citationIds:[],draft:null}));
 const rejected=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',payload:{conversationId:f.conversationId,clientRequestId:crypto.randomUUID(),question:recording,scope:{kind:'all'}}});
 assert.equal(rejected.statusCode,401,rejected.body);assert.equal(f.requests.length,0);
 const accepted=await f.post(recording),message=await f.settled(accepted.message.id);
 assert.equal(message.status,'completed',JSON.stringify(message));assert.equal(message.question,recording);assert.equal(message.result!.answer,acknowledgement);
 assert.deepEqual(message.result!.citations,[]);assert.equal(message.result!.draft,undefined);assert.equal(message.result!.currentAction,undefined);
 assert.equal(f.requests.length,1);assert.match(JSON.stringify(f.requests[0]),/only to record information/,'the real model request must explain the light acknowledgement decision');
 const counts=()=>({captures:f.node.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,memories:f.node.store.db.prepare('SELECT count(*) n FROM memories').get()!.n,tasks:f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,actions:f.node.store.db.prepare('SELECT count(*) n FROM action_proposals').get()!.n});
 assert.deepEqual(counts(),{captures:0,memories:0,tasks:0,actions:0},'the accepted conversation text is not a fabricated capture, Memory publication, Task or external effect');
 const replay=await f.api('POST','/api/conversations/messages',accepted.payload);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().id,message.id);assert.equal(f.requests.length,1);
 await f.restart();const page=await f.api('GET',`/api/conversations/${f.conversationId}?anchor=${message.id}&limit=1`);assert.equal(page.statusCode,200,page.body);const saved=page.json().turns.find((turn:{id:string})=>turn.id===message.id);assert.equal(saved.question,recording);assert.equal(saved.result.answer,acknowledgement);
 const duplicate=await f.api('POST','/api/conversations/messages',accepted.payload);assert.equal(duplicate.statusCode,202,duplicate.body);assert.equal(duplicate.json().id,message.id);assert.equal(f.requests.length,1);assert.deepEqual(counts(),{captures:0,memories:0,tasks:0,actions:0});
});
