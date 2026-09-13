import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';

function fixture(t:TestContext) {
 const directory=mkdtempSync(join(tmpdir(),'mote-source-regression-'));
 const store=new Store(directory),sources=new SourceStore(store);
 sources.register({id:'generated-source',name:'Generated source regression',kind:'local-files',deviceId:'generated-device',platform:'android',retention:'snapshot'});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {store,sources};
}
const item=(externalId='generated-file',revision='revision-1',text='  合成 UTF-8 👩🏽‍💻 e\u0301\r\nUntrusted quoted instructions only.\n')=>({externalId,revision,text,observedAt:'2026-09-13T00:00:00Z',title:'generated.txt',kind:'file',layer:'snapshot'});

test('concurrent identical source submissions share one immutable version and return duplicate ACKs',async t=>{
 const {store,sources}=fixture(t);
 const acknowledgements=await Promise.all(Array.from({length:8},()=>sources.upsert('generated-source',item())));
 assert.equal(new Set(acknowledgements.map(v=>v.id)).size,1);
 assert.equal(acknowledgements.filter(v=>!v.duplicate).length,1);
 assert.equal(acknowledgements.filter(v=>v.duplicate).length,7);
 assert.equal(sources.history('generated-source','generated-file').length,1);
 assert.equal(store.list().totalCount,1);
 const mixed=await Promise.allSettled([sources.upsert('generated-source',item('conflict','same','A')),sources.upsert('generated-source',item('conflict','same','B'))]);
 assert.equal(mixed.filter(v=>v.status==='fulfilled').length,1);
 const rejected=mixed.find(v=>v.status==='rejected');assert.equal(rejected?.status==='rejected'?rejected.reason.statusCode:undefined,409);
 // A failed predecessor must not poison subsequent revisions in the per-item queue.
 await sources.upsert('generated-source',item('conflict','new','C'));
 assert.equal(sources.getItem('generated-source','conflict')?.text,'C');
});

test('empty and whitespace-only source files preserve exact original text through API storage and export',async t=>{
 const {store,sources}=fixture(t);
 for(const [index,text] of ['', '   \r\n\t', '\uFEFF', '  中文 👨‍👩‍👧‍👦\n'].entries()) {
  const value=item(`empty-${index}`,'r1',text),ack=await sources.upsert('generated-source',value);
  assert.equal(sources.getItem('generated-source',value.externalId)?.text,text);
  assert.equal(store.evidence([ack.id])[0].ocrText,text);
 }
 const archive=store.exportArchive(1_000_000),{store:restored,sources:mirror}=fixture(t);
 await restored.importArchive(archive);
 for(let index=0;index<4;index++)assert.equal(mirror.getItem('generated-source',`empty-${index}`)?.text,sources.getItem('generated-source',`empty-${index}`)?.text);
});

test('archive rejects forged future/deleted pointers and revision checksums atomically',async t=>{
 const {store,sources}=fixture(t);await sources.upsert('generated-source',item());
 const original=store.exportArchive(1_000_000);
 const mutations=[
  (archive:any)=>{archive.sourceHeads[0].observed_at='2099-01-01T00:00:00Z';},
  (archive:any)=>{archive.sourceHeads[0].deleted=1;},
  (archive:any)=>{archive.sourceVersions[0].hash='0'.repeat(64);},
 ];
 for(const mutate of mutations) {
  const archive=structuredClone(original);mutate(archive);const {store:restored}=fixture(t);
  await assert.rejects(restored.importArchive(archive));
  assert.equal(restored.evidence(original.captures.map((c:any)=>c.id)).length,0);
  assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM source_versions').get()!.n,0);
  assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM source_heads').get()!.n,0);
 }
});

test('an old duplicate cannot undo a deletion or restoration after a portable archive round trip',async t=>{
 const {store,sources}=fixture(t);
 const first=item();await sources.upsert('generated-source',first);
 const deletion={...first,revision:'removed',observedAt:'2026-09-13T00:00:01Z',deleted:true,title:'',text:''};
 await sources.upsert('generated-source',deletion);
 const restored={...first,revision:'restored',observedAt:'2026-09-13T00:00:02Z'};await sources.upsert('generated-source',restored);
 const {store:destination,sources:mirror}=fixture(t);await destination.importArchive(store.exportArchive(1_000_000));
 mirror.update('generated-source',{enabled:true});
 assert.equal((await mirror.upsert('generated-source',first)).duplicate,true);
 assert.equal((await mirror.upsert('generated-source',deletion)).duplicate,true);
 assert.equal(mirror.getItem('generated-source',first.externalId)?.revision,'restored');
 assert.equal(mirror.getItem('generated-source',first.externalId)?.deleted,false);
 assert.equal(mirror.history('generated-source',first.externalId).length,3);
});

test('each memory must declare its own inline evidence, even when another claim retrieved that record',async t=>{
 const {store,sources}=fixture(t),memories=new MemoryStore(store);
 const a=await sources.upsert('generated-source',item('memory-a','r1','合成材料 A'));
 const b=await sources.upsert('generated-source',item('memory-b','r1','合成材料 B'));
 const first={title:'材料 A',statement:`合成陈述 [${a.id}]`,uncertainty:'不推断实际完成',evidenceIds:[a.id]};
 const second={title:'材料 B',statement:`另一个合成陈述 [${b.id}]`,uncertainty:'不推断实际完成',evidenceIds:[b.id]};
 const result=(claims:typeof first[])=>({answer:JSON.stringify({memories:claims}),citations:[a,b].map(ack=>({id:ack.id,capturedAt:item().observedAt,appName:'generated',excerpt:'generated'})),trace:[],runId:'generated-memory-regression'});
 for(const invalid of [
  {...second,statement:`错配但已在外层读取 [${a.id}]`},
  {...second,uncertainty:`限制也引用了未为本条声明的证据 [${a.id}]`},
 ]) {
  assert.throws(()=>memories.extract(result([first,invalid]),'fixture-model'),/inline citation missing from citationIds/);
  assert.equal(memories.list().length,0,'validation must finish before any memory is saved');
 }
 // Literal code copied from untrusted evidence is not a prose citation.
 const quoted={...second,statement:second.statement+`\n\n\`[${a.id}]\`\n\n\`\`\`text\n[${a.id}]\n\`\`\``};
 const saved=memories.extract(result([first,quoted]),'fixture-model');
 assert.equal(saved.items.length,2);
 assert.deepEqual(saved.items[1].evidenceIds,[b.id]);
});

test('merging an archive with a newer current version invalidates previous derived conclusions',async t=>{
 const {store:destination,sources:local}=fixture(t),{store:origin,sources:remote}=fixture(t);
 const first=item(),ack=await local.upsert('generated-source',first);await remote.upsert('generated-source',first);
 const memories=new MemoryStore(destination),memory=memories.extract({answer:JSON.stringify({memories:[{title:'合成旧结论',statement:`旧版本的陈述 [${ack.id}]`,uncertainty:'仅供回归验证',evidenceIds:[ack.id]}]}),citations:[{id:ack.id,capturedAt:first.observedAt,appName:'generated',excerpt:'generated'}],trace:[],runId:'generated-import-memory'},'fixture-model').items[0];
 memories.publish(memory.id);destination.saveInsight({answer:'合成旧洞察',citations:[{id:ack.id}]},'generated-import-insight');
 const before=destination.deletionRevision();
 await remote.upsert('generated-source',{...first,revision:'r2',observedAt:'2026-09-13T00:01:00Z',text:'合成修订版本'});
 const archive=origin.exportArchive(1_000_000);await destination.importArchive(archive);
 assert.equal(local.getItem('generated-source',first.externalId)?.revision,'r2');
 assert.equal(memories.get(memory.id).status,'stale');
 assert.equal(destination.insights().length,0);
 assert.ok(destination.deletionRevision()>before,'active readers must see the superseded evidence revision');
 const revision=destination.deletionRevision();await destination.importArchive(archive);
 assert.equal(destination.deletionRevision(),revision,'an identical archive retry must not create another supersession');
});

test('archive merge rejects ambiguous equal-time current pointers without partially importing records',async t=>{
 const {store:destination,sources:local}=fixture(t),{store:origin,sources:remote}=fixture(t);
 const first=item();await local.upsert('generated-source',first);await remote.upsert('generated-source',first);
 const later=await remote.upsert('generated-source',{...first,revision:'same-time-new',text:'合成同观察时间的另一版本'});
 await assert.rejects(destination.importArchive(origin.exportArchive(1_000_000)),{statusCode:409});
 assert.equal(local.getItem('generated-source',first.externalId)?.revision,first.revision);
 assert.equal(destination.evidence([later.id]).length,0);
 assert.equal(local.history('generated-source',first.externalId).length,1);
});

test('archive imports account for source and memory metadata in the destination storage quota',async t=>{
 const {store,sources}=fixture(t),ack=await sources.upsert('generated-source',item());
 const memory={title:'合成容量检查',statement:`${'合成陈述。'.repeat(100)} [${ack.id}]`,uncertainty:'仅用于生成的容量测试',evidenceIds:[ack.id]};
 new MemoryStore(store).extract({answer:JSON.stringify({memories:[memory]}),citations:[{id:ack.id,capturedAt:item().observedAt,appName:'generated',excerpt:'generated'}],trace:[],runId:'generated-capacity'},'fixture-model');
 const directory=mkdtempSync(join(tmpdir(),'mote-source-quota-'));
 const destination=new Store(directory,{maxStorageBytes:store.logicalBytes()-500});
 t.after(()=>{destination.close();rmSync(directory,{recursive:true,force:true});});
 await assert.rejects(destination.importArchive(store.exportArchive(1_000_000)),{statusCode:507});
 assert.equal(destination.list().totalCount,0);
 assert.equal(destination.db.prepare('SELECT COUNT(*) AS n FROM source_connections').get()!.n,0);
 assert.equal(destination.db.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n,0);
 assert.equal(destination.updates(0).items.length,0);
});
