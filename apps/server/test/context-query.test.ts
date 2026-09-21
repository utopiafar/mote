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
