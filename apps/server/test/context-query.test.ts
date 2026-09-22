import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ContextQuery} from '../src/context-query.js';

const captured=(minutes:number)=>new Date(Date.parse('2026-09-18T00:00:00.000Z')+minutes*60000).toISOString();
async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'mote-context-query-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
  sources.register({id:'coding',name:'Generated coding source',kind:'coding-agent',deviceId:'fixture-device',platform:'import'});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  return {store,sources,query:new ContextQuery(store,sources)};
}
async function coding(store:Store,minutes:number,projectKey:string,sessionId:string,text:string,provider:'codex'|'claude'='codex'){
  const id=randomUUID();await store.ingest({id,deviceId:sessionId==='s-a'?'device-a':'device-b',deviceName:'Generated device',platform:'import',capturedAt:captured(minutes),durationMs:0,appId:'generated.agent',appName:'Generated Agent',windowTitle:'Generated coding turn',ocrText:text,source:'message',provenance:{sourceId:'coding',externalId:id,revision:'1',layer:'snapshot',document:{contentRole:'transcript',coding:{version:1,provider,sessionId,projectKey,eventId:id,role:'user',part:0,parts:1}}},privacy:{excluded:false,redacted:false,mode:'none'}});return id;
}

test('unified context query keeps candidate projects explainable and reads exact hit ranges',async t=>{
  const {store,sources,query}=await fixture(t);
  const first=await coding(store,1,'github:utopiafar/mote','s-a','ANCHOR_REFACTOR: use the batch read path; the rollback test passed.');
  const second=await coding(store,2,'github:utopiafar/mote','s-b','ANCHOR_REFACTOR follow-up: the same repository continues on another device; the old single-row path is superseded.','claude');
  await coding(store,3,'github:other/mote','s-c','ANCHOR_REFACTOR appears in a different repository and must remain separate.');

  const searched=query.search({query:'ANCHOR_REFACTOR',projectKey:'github:utopiafar/mote',limit:1});
  assert.equal(searched.items.length,1);assert.equal(searched.items[0].id,second);assert.equal(searched.items[0].origin.projectKey,'github:utopiafar/mote');assert.ok(searched.items[0].locator);assert.ok(searched.nextCursor,'search cursor must be resumable');
  const next=query.search({query:'ANCHOR_REFACTOR',projectKey:'github:utopiafar/mote',limit:1,cursor:searched.nextCursor!});
  assert.equal(next.items.length,1);assert.equal(next.items[0].id,first);

  const browse=query.browse({query:'mote',limit:10});
  assert.equal(browse.items.length,3,'candidate views preserve provider/device identities even with a matching project key');
  assert.ok(browse.items.every(item=>item.snippet.includes('not a canonical project identity')),JSON.stringify(browse.items));
  const read=query.read([`capture:${first}`],searched.items[0].locator!.offset,12);
  assert.equal(read.items[0].text,'ANCHOR_REFAC');assert.equal(read.missingRefs.length,0);

  const context=query.context({query:'ANCHOR_REFACTOR',projectKey:'github:utopiafar/mote',maxCharacters:5000,includeMemories:false});
  assert.equal(context.recentRecords.length,2);assert.ok(JSON.stringify(context).length<=5000);assert.ok(context.coverage.originalLatestAt);
  const status=query.status();assert.equal(status.archive.captures,3);assert.equal(status.sources.length,1);
});

test('literal search remains bounded on generated archive data',async t=>{
  const {store,sources,query}=await fixture(t);
  for(let i=0;i<120;i++)await coding(store,i%60,'github:utopiafar/mote',`s-${i%3}`,`generated filler ${i} ${i===119?'EFFICIENCY_ANCHOR':''}`);
  const started=performance.now();const result=query.search({query:'EFFICIENCY_ANCHOR',limit:5});const durationMs=performance.now()-started;
  assert.equal(result.items.length,1);assert.match(result.items[0].snippet,/EFFICIENCY_ANCHOR/);assert.ok(result.items[0].locator);assert.ok(durationMs<1000,`fixture lexical search was too slow: ${durationMs}ms`);assert.equal(sources.listSources().length,1);
});

test('137 same-time records paginate without omissions under item and response budgets',async t=>{
  const {store,query}=await fixture(t);const expected=new Set<string>();
  for(let i=0;i<137;i++)expected.add(await coding(store,0,'github:fixture/mote',`s-${i%5}`,'PAGING_ANCHOR '+i+' '+ '合成数据'.repeat(150)));
  for(const maxCharacters of [16000,3000,1000]){
    const seen:string[]=[];let cursor:string|undefined;
    for(let page=0;page<200;page++){
      const result=query.search({query:'PAGING_ANCHOR',limit:20,maxCharacters,cursor});
      assert.ok(JSON.stringify(result).length<=maxCharacters,JSON.stringify({maxCharacters,length:JSON.stringify(result).length}));
      assert.equal(result.coverage.recordsReturned,result.items.length);
      seen.push(...result.items.map(r=>r.id));if(!result.nextCursor)break;
      assert.notEqual(result.nextCursor,cursor);cursor=result.nextCursor;
    }
    assert.equal(seen.length,137);assert.equal(new Set(seen).size,137);assert.deepEqual(new Set(seen),expected);
  }
});

test('memory references expand and strict device/time/coding scope applies before pagination',async t=>{
  const {store,query}=await fixture(t);const evidence=await coding(store,1,'github:fixture/mote','same','Evidence');
  const id=randomUUID();store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(id,captured(2),JSON.stringify({id,title:'Generated memory',statement:'Supported fixture',uncertainty:'fixture',status:'published',createdAt:captured(2),evidenceIds:[evidence],evidence:[{id:evidence,deviceId:'device-b',capturedAt:captured(1)}],admission:{layer:'memory'},scopeRefs:[{provider:'codex',projectKey:'github:fixture/mote',sessionId:'same'}]}));
  store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(id,evidence);
  assert.equal(query.read(['memory:'+id]).items[0].id,id);
  assert.equal(query.read(['memory:'+id],0,4000,{deviceId:'device-a'}).items.length,0);
  assert.equal(query.read(['memory:'+id],0,4000,{sourceId:'other'}).items.length,0);
  assert.equal(query.read(['memory:'+id],0,4000,{deviceId:'device-b',sourceId:'coding'}).items[0].id,id);
  assert.equal(query.read(['memory:'+id],0,4000,{after:captured(5)}).items.length,0);
  assert.equal(query.context({sourceId:'other'}).stableMemories.length,0);
  assert.equal(query.context({sourceId:'coding'}).stableMemories.length,1);
  assert.equal(query.context({deviceId:'device-a'}).stableMemories.length,0);
  assert.equal(query.context({after:captured(5)}).stableMemories.length,0);
  assert.equal(query.context({provider:'claude'}).stableMemories.length,0);
  assert.equal(query.context({provider:'codex',deviceId:'device-b'}).stableMemories.length,1);
});

test('same session labels across providers do not merge; collections carry expansion references',async t=>{
 const {store,query}=await fixture(t);
 await coding(store,1,'github:fixture/mote','same','generated','codex');
 await coding(store,2,'github:fixture/mote','same','generated','claude');
 assert.equal(query.context({}).recentSessions.length,2);
 const card=query.browse({}).items[0];assert.equal(card.expansion?.kind,'search');assert.ok(query.search(card.expansion!.scope).items.length>0);assert.equal(query.read(card.expansion!.refs).items.length,1);
});

test('repository candidates span devices while expansion and memories keep exact source identity',async t=>{
 const {sources,store,query}=await fixture(t),repositoryKey='a'.repeat(64);
 for(let i=0;i<3;i++){
  sources.register({id:`source-${i}`,name:'Generated example',kind:'coding-agent',deviceId:`device-${i}`,platform:'import'});
  await sources.upsert(`source-${i}`,{externalId:'same',revision:'1',observedAt:captured(i),kind:'message',layer:'snapshot',text:'Generated evidence',document:{coding:{version:1,provider:'codex',sessionId:'same',projectKey:'same-path-hash',projectName:'example',...(i<2?{repositoryKey,branch:i?'main':'fixture'}:{}),eventId:'event',role:'user',part:0,parts:1}}});
 }
 const candidates=query.browse({query:'example'});assert.equal(candidates.items.length,3);
 for(const card of candidates.items){const expanded=query.search(card.expansion!.scope);assert.equal(expanded.items.length,1);assert.equal(expanded.items[0].origin.sourceId,card.origin.sourceId);}
 const related=query.browse({repositoryKey});assert.equal(related.items.length,2);assert.equal(new Set(related.items.map(c=>c.origin.deviceId)).size,2);
 assert.equal(query.search({repositoryKey,sourceId:'source-2'}).items.length,0);
 assert.equal(store.list({repositoryKey,limit:1}).items.length,1);
});

test('navigation references survive reader reconstruction and intersect the original view with later scopes',async t=>{
 const {store,sources,query}=await fixture(t);
 const repositoryKey='b'.repeat(64),batches=new Map<string,any[]>([['nav-0',[]],['nav-1',[]]]);
 for(let i=0;i<400;i++){
  const sourceId=`nav-${i%2}`,deviceId=`nav-device-${i%2}`;
  if(i<2)sources.register({id:sourceId,name:'Generated navigation',kind:'coding-agent',deviceId,platform:'import'});
  const item={externalId:`day-${i}`,revision:'1',observedAt:new Date(Date.UTC(2024,0,1+i)).toISOString(),kind:'message',layer:'snapshot',text:`NAVIGATION_${i}`,document:{coding:{version:1,provider:'codex',sessionId:'same-session',projectKey:'same-project',repositoryKey,eventId:`day-${i}`,role:'user',part:0,parts:1}}};
  if(i<200)await sources.upsert(sourceId,item);else batches.get(sourceId)!.push(item);
 }
 for(const [sourceId,items] of batches)await sources.upsertBatch(sourceId,items);
 const scope={sourceId:'nav-0',after:'2024-06-01T00:00:00.000Z',before:'2024-12-01T00:00:00.000Z'};
 const cards=[...query.browse(scope).items,...query.context({...scope,includeMemories:false}).recentSessions];
 assert.ok(cards.some(c=>c.kind==='session'));assert.ok(cards.some(c=>c.kind==='project-candidate'));
 const restored=new ContextQuery(store,sources);
 for(const card of cards){
  assert.ok(card.ref.length<=4096);
  const item=restored.read([card.ref]).items[0];assert.equal(item.text,'');assert.equal(item.evidenceRefs,undefined);
  assert.deepEqual(item.expansion,card.expansion);
  assert.equal(restored.read([card.ref],0,4000,{sourceId:'nav-1'}).items.length,0);
  assert.equal(restored.read([card.ref],0,4000,{before:scope.after}).items.length,0);
  const narrower=restored.read([card.ref],0,4000,{after:'2024-07-01T00:00:00.000Z',before:'2025-01-01T00:00:00.000Z'}).items[0];
  assert.equal(narrower.expansion!.scope.after,'2024-07-01T00:00:00.000Z');assert.equal(narrower.expansion!.scope.before,scope.before);
  const expanded=restored.search(narrower.expansion!.scope);assert.ok(expanded.items.length>0);
  assert.ok(expanded.items.every(row=>row.origin.sourceId==='nav-0'&&row.origin.capturedAt>=narrower.expansion!.scope.after!&&row.origin.capturedAt<scope.before));
 }
 const anchor=cards[0].expansion!.refs[0].slice('capture:'.length);store.delete(anchor);
 assert.equal(restored.read([cards[0].ref]).items.length,0,'deleted anchors do not silently switch to another record');
 for(const ref of [cards[0].ref+'=',cards[0].ref+'/x','collection:v1:'+Buffer.from(JSON.stringify({anchor,scope:{sourceId:'nav-0'},instructions:'untrusted'})).toString('base64url')])assert.equal(restored.read([ref]).items.length,0);
});

test('post-filtered memory pages advance without a false response-budget error',async t=>{
 const {store,query}=await fixture(t),evidence=await coding(store,1,'fixture','same','Scope fixture');
 for(let i=0;i<25;i++){
  const id=randomUUID(),createdAt=captured(i+2);
  store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(id,createdAt,JSON.stringify({id,title:'Generated scoped memory',statement:'Fixture',uncertainty:'fixture',status:'published',createdAt,evidenceIds:[evidence],admission:{layer:'memory'}}));
  store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(id,evidence);
 }
 let cursor:string|undefined,finished=false;
 for(let page=0;page<4;page++){
  const result=query.context({appId:'out-of-scope',limit:10,cursor});assert.deepEqual(result.stableMemories,[]);
  if(!result.nextCursor){finished=true;break;}assert.notEqual(result.nextCursor,cursor);cursor=result.nextCursor;
 }
 assert.equal(finished,true);
});
