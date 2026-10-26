import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readOriginTurn,conversationTurnRoute} from '../src/conversation-origin';
import type {Api} from '../src/api';
test('saved origin finds exact older turn, never a similar question, and rejects changed/revoked pages',async()=>{
 const wanted={id:'old',question:'same question'},signal=new AbortController().signal;
 const requests:string[]=[];
 const api={request:async(path:string)=>{requests.push(path);return path.includes('?')?{id:'c',revision:1,turns:[wanted]}:{id:'c',revision:1,turns:[{id:'new',question:'same question'}],nextCursor:'older'};}} as Api;
 assert.deepEqual(await readOriginTurn(api,'c','old',signal),wanted);assert.equal(requests.length,2);
 assert.equal(conversationTurnRoute('c','old'),'#/ask?conversation=c&turn=old');
 for(const replacement of [{id:'c',revision:2,turns:[wanted]},{id:'other',revision:1,turns:[wanted]}]){
  const changed={request:async(path:string)=>path.includes('?')?replacement:{id:'c',revision:1,turns:[],nextCursor:'older'}} as Api;
  await assert.rejects(readOriginTurn(changed,'c','old',signal));
 }
 const denied={request:async()=>{throw Error('403');}} as Api;
 await assert.rejects(readOriginTurn(denied,'c','old',signal),/403/);
 const deleted={request:async()=>({id:'c',turns:[{...wanted,evidenceDeleted:true}]})} as Api;
 assert.equal(await readOriginTurn(deleted,'c','old',signal),undefined);
});
