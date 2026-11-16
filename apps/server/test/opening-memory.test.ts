import test from 'node:test';
import assert from 'node:assert/strict';
import type {ContextReader} from '@mote/agent';
import {openingMemoryContext} from '../src/opening-memory.js';

const createdAt='2026-09-18T00:00:00Z';
const originalId='6f28159f-242b-5442-9a0c-a17958985a52';
const reader=(details:Record<string,unknown>[]):ContextReader=>({
  search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[],
  memories:async args=>({items:args.id?details.filter(item=>item.id===args.id):details}),
});
const card=(id:string,extra:Record<string,unknown>={})=>({id,title:'Generated account',statement:'The source narrator planned a visit.',uncertainty:'The outcome is unknown.',status:'published',tier:'episode',createdAt,evidenceIds:[originalId],...extra});

test('opening leads preserve derived limits without disclosing original evidence or owner statements',async()=>{
 const detail=card('generated-card',{admission:{layer:'memory',reason:'Generated reason',scope:'Only the source narrator and this dated plan',attribution:'observed'},validFrom:'2026-09-18T00:00:00+08:00',validUntil:'2026-10-01T00:00:00+08:00',
  evidence:[{id:originalId,quote:'GENERATED ORIGINAL QUOTE',attributionContext:{version:1,ownerRelation:'owner',basis:'owner_source',ownerStatements:[{id:'generated-owner',question:'Generated question',answer:'GENERATED OWNER STATEMENT'}]}}]});
 const result=await openingMemoryContext(reader([detail]),'What was planned?',{contextTime:'2026-09-20T00:00:00Z'});
 assert.equal(result.leads.length,1,'duplicate catalog candidates disclose one lead');
 assert.deepEqual(result.leads[0].admission,{scope:'Only the source narrator and this dated plan',attribution:'observed'});
 assert.equal(result.leads[0].validFrom,detail.validFrom);assert.equal(result.leads[0].validUntil,detail.validUntil);
 assert.deepEqual(result.evidenceDependencies,{version:1,complete:true,ids:['generated-card',originalId]});
 const serialized=JSON.stringify(result.leads);
 for(const privateValue of [originalId,'GENERATED ORIGINAL QUOTE','GENERATED OWNER STATEMENT','ownerRelation','ownerStatements','Generated reason'])assert.ok(!serialized.includes(privateValue));
});

test('malformed optional metadata and legacy missing fields never manufacture a lead identity or validity',async()=>{
 const result=await openingMemoryContext(reader([
  card('legacy'),
  card('invalid',{admission:{layer:'memory',scope:'Generated',attribution:{toString:()=> 'user'}},validFrom:'2026-09-18',validUntil:'not-a-date'}),
 ]),'Generated question',{});
 assert.equal(result.leads.length,2);
 for(const lead of result.leads){assert.equal(lead.admission,undefined);assert.equal(lead.validFrom,undefined);assert.equal(lead.validUntil,undefined);}
 assert.deepEqual(result.evidenceDependencies.ids,['legacy',originalId,'invalid']);
});

test('all explicitly standing cards survive pagination and newer ordinary cards without clipping their limits',async()=>{
 const standing=Array.from({length:7},(_,index)=>card('standing-'+index,{contextPriority:'standing',title:'Generated standing title '.repeat(10)+index,
  statement:'Generated scoped constraint. '.repeat(40)+'EXACT APPLICABILITY TAIL',uncertainty:'Generated uncertainty. '.repeat(20)+'UNCERTAINTY TAIL',
  admission:{layer:'memory',reason:'Generated standing choice',scope:'Only this generated project',attribution:index===0?'third_party':'user'}}));
 const ordinary=Array.from({length:12},(_,index)=>card('recent-'+index,{title:'Newer generated ordinary card',createdAt:'2026-09-19T00:00:00Z'})),details=[...standing,...ordinary],calls:any[]=[];
 const scoped:ContextReader={...reader(details),memories:async args=>{
  calls.push(args);
  if(args.id)return {items:details.filter(item=>item.id===args.id)};
  if(args.contextPriority==='standing'){const offset=Number(args.cursor??0);return {items:standing.slice(offset,offset+3),nextCursor:offset+3<standing.length?String(offset+3):null};}
  return {items:ordinary.slice(0,args.limit)};
 }};
 const result=await openingMemoryContext(scoped,'Generated request',{deviceId:'generated',contextTime:'2026-09-20T00:00:00Z'});
 assert.deepEqual(result.leads.filter(item=>item.contextPriority==='standing').map(item=>item.id),standing.map(item=>item.id));
 assert.equal(result.leads.length,12,'all seven standing items coexist with five optional ordinary leads');
 assert.equal(result.leads[0].title,standing[0].title);assert.equal(result.leads[0].statement,standing[0].statement);assert.equal(result.leads[0].uncertainty,standing[0].uncertainty);assert.equal(result.leads[0].admission?.attribution,'third_party');
 assert.equal(calls.filter(call=>call.contextPriority==='standing').length,3);
 assert.ok(calls.every(call=>call.deviceId==='generated'&&call.asOf==='2026-09-20T00:00:00Z'));
 assert.ok(standing.every(item=>result.evidenceDependencies.ids.includes(item.id)));assert.equal(result.evidenceDependencies.complete,true);
});

test('a repeated standing cursor fails explicitly instead of returning a partial standing set',async()=>{
 const scoped={...reader([]),memories:async()=>({items:[],nextCursor:'repeated'})};
 await assert.rejects(openingMemoryContext(scoped,'Generated request',{}),/pagination changed/);
});
