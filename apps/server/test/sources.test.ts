import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-source-'));const store=new Store(dir);const sources=new SourceStore(store);sources.register({id:'fixture',name:'合成资料',kind:'custom',deviceId:'synthetic',platform:'import',retention:'snapshot'});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,sources};}
const item=(revision='r1',observedAt='2026-09-12T10:00:00Z')=>({externalId:'复杂/资料-🌱',revision,observedAt,title:'合成资料：计划、取消与未知结果',text:'我计划下周整理预算，但目前还未完成。\n其他人的话：“我一定做好了”。这不代表我的进度。',kind:'file',layer:'snapshot'});
test('immutable revisions, late delivery, pause, deletion and restoration preserve current pointer',async t=>{
 const {store,sources}=fixture(t);const first=await sources.upsert('fixture',item());assert.equal(store.list().items.length,1);
 assert.equal((await sources.upsert('fixture',{...item(),observedAt:'2026-09-12T10:01:00Z'})).duplicate,true);
 await assert.rejects(sources.upsert('fixture',{...item(),text:'conflicting revision'}),{statusCode:409});
 const second=await sources.upsert('fixture',{...item('r2','2026-09-12T11:00:00Z'),text:'更正：资料仅完成草稿，还没有发出去。'});
 assert.deepEqual(store.list().items.map(i=>i.id),[second.id]);assert.equal(sources.history('fixture',item().externalId).length,2);
 await sources.upsert('fixture',item('late','2026-09-12T10:30:00Z'));assert.equal(store.list().items[0].id,second.id);
 await sources.upsert('fixture',{...item('delete','2026-09-12T12:00:00Z'),deleted:true,text:''});assert.equal(store.list().items.length,0);
 assert.equal((await sources.upsert('fixture',item())).duplicate,true);assert.equal(store.list().items.length,0);
 await sources.upsert('fixture',item('restore','2026-09-12T13:00:00Z'));assert.equal(store.list().items.length,1);
 sources.update('fixture',{enabled:false});assert.equal(sources.register({id:'fixture',name:'again',kind:'custom',deviceId:'synthetic',platform:'import'}).enabled,false);await assert.rejects(sources.upsert('fixture',item('blocked')),{statusCode:409});
 assert.equal(store.evidence([first.id])[0].ocrText,item().text);assert.equal(store.activity().totalDurationMs,0);
});
test('calendar event time overlaps independent observation time, with all-day DST and device bounds',async t=>{
 const {store,sources}=fixture(t);const calendar={start:'2026-11-01T00:00:00-04:00',end:'2026-11-02T00:00:00-05:00',allDay:true,timeZone:'America/New_York',status:'confirmed'};
 await sources.upsert('fixture',{...item(),kind:'calendar',calendar});
 assert.equal(sources.listItems({after:'2026-11-01T23:00:00Z',before:'2026-11-02T01:00:00Z'}).items.length,1);
 assert.equal(sources.listItems({deviceId:'other'}).items.length,0);assert.equal(store.activity().totalDurationMs,0);
 await assert.rejects(sources.upsert('fixture',{...item('invalid'),kind:'calendar',calendar:{...calendar,end:'2025-01-01T00:00:00Z'}}));
});
test('reference/shadow data never accepts hidden original text and reads metadata without fetching',async t=>{
 const {sources,store}=fixture(t);sources.update('fixture',{retention:'reference'});
 await assert.rejects(sources.upsert('fixture',item()),{statusCode:409});
 await assert.rejects(sources.upsert('fixture',{...item(),layer:'reference'}));
 const ack=await sources.upsert('fixture',{...item(),layer:'reference',text:'',uri:'nas://home/documents/预算.txt'});
 assert.equal(sources.getItem('fixture',item().externalId)?.text,'');assert.equal(store.evidence([ack.id])[0].ocrText,'');
 await assert.rejects(sources.upsert('fixture',{...item('unsafe'),layer:'reference',text:'',uri:'https://user:password@example.com/private'}));
});
test('portable archive restores source pointers, history and safe paused connections',async t=>{
 const {store,sources}=fixture(t);await sources.upsert('fixture',item());await sources.upsert('fixture',item('r2','2026-09-12T11:00:00Z'));
 const dir=mkdtempSync(join(tmpdir(),'mote-source-restore-'));const restored=new Store(dir);t.after(()=>{restored.close();rmSync(dir,{recursive:true,force:true});});
 const archive=store.exportArchive(1_000_000);await restored.importArchive(archive);const mirror=new SourceStore(restored);
 assert.equal(mirror.listSources().length,1);assert.equal(mirror.getSource('fixture').enabled,false);assert.equal(mirror.history('fixture',item().externalId).length,2);assert.equal(restored.list().items.length,1);
 assert.equal(mirror.listItems().items[0].revision,'r2');
});
test('model memories disclose overview/detail/evidence and invalidate on revision or deletion',async t=>{
 const {store,sources}=fixture(t),memories=new MemoryStore(store);const ack=await sources.upsert('fixture',item());
 const result={answer:JSON.stringify({memories:[{title:'合成资料尚未完成',statement:`当前仍是计划 [${ack.id}]`,uncertainty:'未有完成证据',evidenceIds:[ack.id]}]}),citations:[{id:ack.id,capturedAt:item().observedAt,appName:'fixture',excerpt:'计划'}],trace:[],runId:'fixture-run'};
 const saved=memories.extract(result,'fixture-model');assert.equal(saved.items.length,1);assert.ok(!('statement' in memories.list()[0]));assert.equal(memories.get(saved.items[0].id).statement,saved.items[0].statement);
 assert.equal(memories.extract({...result,answer:JSON.stringify({...JSON.parse(result.answer),citationIds:[ack.id]})},'fixture-model').items[0].id,saved.items[0].id);
 assert.throws(()=>memories.extract({...result,answer:JSON.stringify({...JSON.parse(result.answer),citationIds:[]})},'fixture-model'),{statusCode:502});
 assert.equal(memories.list({deviceId:'other'}).length,0);memories.publish(saved.items[0].id);
 await sources.upsert('fixture',item('r2','2026-09-12T11:00:00Z'));assert.equal(memories.list().length,0);assert.equal(memories.get(saved.items[0].id).status,'stale');assert.throws(()=>memories.publish(saved.items[0].id),{statusCode:409});
 store.delete(ack.id);assert.equal(memories.list({includeStale:true}).length,0);
 assert.throws(()=>memories.extract({...result,answer:'invented'},'fixture'),{statusCode:502});
});
