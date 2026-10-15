import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {installPrivateData} from '../src/scope/private-data-schema.js';
import {PrivateData} from '../src/scope/private-data.js';
import {PrivateCursor,PrivateSql} from '../src/scope/private-data-sql.js';
import {privateDataLifecycle} from '../src/scope/private-data-lifecycle.js';
import {materialDraftSchema} from '../src/scope/material-model.js';
import type {UserContext} from '../src/scope/context.js';
import type {LifecyclePurpose,UserDataSubject,UserExport} from '../src/scope/lifecycle.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const materialId=(external:string)=>'mat_'+hash(['same-source',external]);
const standaloneId='11111111-1111-4111-8111-111111111111';
const bOnlyCapture='22222222-2222-4222-8222-222222222222';
const at='2026-01-01T00:00:00.000Z';
const copy=<T>(value:T):T=>structuredClone(value);

function fixture(t:any){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');t.after(()=>db.close());
  const cursorKey=installPrivateData(db),deploymentId='synthetic-deployment';
  // This is a repository fixture, not the production authentication path. The
  // production composition tests separately exercise host-issued contexts.
  const a=Object.freeze({deploymentId,userId:'synthetic-a',credentialId:'fixture-a',authorizationEpoch:1}) as UserContext;
  const b=Object.freeze({deploymentId,userId:'synthetic-b',credentialId:'fixture-b',authorizationEpoch:1}) as UserContext;
  const purposes:LifecyclePurpose[]=[],subjects=new Set<UserDataSubject>([a,b]);
  let failStatement:((statement:string)=>boolean)|undefined;
  const sqlFor=(subject:UserDataSubject,purpose:LifecyclePurpose)=>{
    purposes.push(purpose);
    const sql=new PrivateSql(db,subject.userId,()=>assert.ok(subjects.has(subject),'fixture host provenance'));
    const run=sql.run.bind(sql);sql.run=(statement,...args)=>{const result=run(statement,...args);if(failStatement?.(statement))throw Error('synthetic transaction failure');return result;};
    return sql;
  };
  const repository=(subject:UserContext)=>new PrivateData(new PrivateSql(db,subject.userId,()=>assert.ok(subjects.has(subject))),new PrivateCursor(cursorKey,deploymentId,subject.userId));
  const lifecycle=privateDataLifecycle(sqlFor);
  const seed=(subject:UserContext,label:string)=>{
    const data=repository(subject);
    data.registerSource({id:'same-source',name:label+' source',kind:'custom',deviceId:'same-device',platform:'import',ownerRelation:'owner'});
    data.updateSourceContext('same-source',{expectedVersion:0,description:label+' initial context'});
    const context=data.updateSourceContext('same-source',{expectedVersion:1,description:label+' current context'});
    data.receiveCaptures([{id:standaloneId,deviceId:'same-device',deviceName:'Fixture',platform:'import',capturedAt:at,durationMs:0,ocrText:label+' note',source:'note'}]);
    const sourceCapture=data.receiveSourceItems('same-source',[{externalId:'same-external',revision:'same-version',observedAt:at,title:label+' document',text:label+' original',kind:'file',layer:'original'}]).receipts[0].id;
    const draft={id:materialId('parent'),kind:'mote.document',schemaVersion:1,title:label+' material',origin:{sourceId:'same-source',externalId:'parent'},
      attributionContext:{version:1,ownerRelation:'owner',basis:'owner_source',sourceDeclaration:{sourceId:'same-source',version:1,ownerRelation:'owner'},
        sourceContextDeclarations:[{sourceId:'same-source',version:context.version,fingerprint:context.fingerprint}],sourceContextStatements:[{sourceId:'same-source',version:context.version,description:context.description}]},
      blocks:[{id:'text',kind:'text',format:'plain',text:label+' processed',memberIds:['original','note'],evidenceIds:[sourceCapture,standaloneId]}],
      members:[{id:'original',kind:'capture',ref:'capture:'+sourceCapture,revision:'same-version'},{id:'note',kind:'capture',ref:'capture:'+standaloneId}],
      coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
    const first=data.publishMaterial(draft),second=data.publishMaterial({...draft,blocks:[{...draft.blocks[0],text:label+' processed revision 2'}]},first.revision);
    const child=data.publishMaterial({id:materialId('child'),kind:'mote.document',schemaVersion:1,title:label+' child',origin:{sourceId:'same-source',externalId:'child'},
      blocks:[{id:'child-text',kind:'text',format:'plain',text:label+' derived child',memberIds:['parent']}],members:[{id:'parent',kind:'material',ref:second.ref,revision:second.revision}],
      coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
    return {data,sourceCapture,parent:second,child};
  };
  return {db,a,b,purposes,repository,lifecycle,seed,fail:(predicate?:typeof failStatement)=>{failStatement=predicate;}};
}

test('canonical export covers this user, exact revisions and dependency rows without owners, indexes or other domains',async t=>{
  const f=fixture(t);f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  const archive=await f.lifecycle.exportUser(f.a),payload=archive.payload as any;
  assert.deepEqual({domain:archive.domain,version:archive.version,deploymentId:archive.deploymentId,userId:archive.userId},{domain:'private-data',version:1,deploymentId:f.a.deploymentId,userId:f.a.userId});
  assert.equal(payload.format,'mote-private-data-v1');
  assert.deepEqual(payload.coverage.excluded,['assets','credentials','other-domains']);
  assert.equal(payload.sources.length,1);assert.equal(payload.source_contexts.length,2);assert.equal(payload.captures.length,2);assert.equal(payload.source_heads.length,1);
  assert.equal(payload.materials.length,2);assert.equal(payload.material_versions.length,3);assert.equal(payload.material_captures.length,4);assert.equal(payload.material_inputs.length,1);
  assert.equal(payload.material_contexts.length,3);assert.equal(payload.material_sources.length,3);
  const body=JSON.stringify(payload);assert.ok(body.includes('synthetic A'));assert.ok(!body.includes('synthetic B'));assert.ok(!body.includes('user_id'));
  assert.equal(payload.pd_fts,undefined);assert.equal(payload.pd_meta,undefined);assert.deepEqual(f.purposes,['export']);
});

test('delete and exact restore are idempotent, rebuild FTS, preserve B and keep captured ownership',async t=>{
  const f=fixture(t),a=f.seed(f.a,'synthetic A'),b=f.seed(f.b,'synthetic B');
  const archive=await f.lifecycle.exportUser(f.a),bBefore=hash(await f.lifecycle.exportUser(f.b));
  const ftsBefore=Number(f.db.prepare('SELECT COUNT(*) n FROM pd_fts WHERE user_id=?').get(f.a.userId)!.n);
  assert.ok(ftsBefore>0);
  assert.deepEqual(await f.lifecycle.deleteUser(f.a,'synthetic-delete'),{status:'complete',operationId:'synthetic-delete'});
  assert.deepEqual(await f.lifecycle.deleteUser(f.a,'synthetic-delete'),{status:'complete',operationId:'synthetic-delete'});
  assert.deepEqual(f.repository(f.a).statistics(),{sources:0,captures:0,materials:0});
  assert.equal(Number(f.db.prepare('SELECT COUNT(*) n FROM pd_fts WHERE user_id=?').get(f.a.userId)!.n),0);
  assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);assert.ok(b.data.readMaterial(b.parent.id).text.includes('synthetic B'));
  await f.lifecycle.restoreUser(f.a,archive,'synthetic-restore');
  assert.deepEqual(await f.lifecycle.exportUser(f.a),archive);
  await f.lifecycle.restoreUser(f.a,archive,'synthetic-restore');
  const shuffled=copy(archive);for(const name of (shuffled.payload as any).coverage.canonicalTables)(shuffled.payload as any)[name].reverse();
  await f.lifecycle.restoreUser(f.a,shuffled,'synthetic-restore');
  assert.equal(Number(f.db.prepare('SELECT COUNT(*) n FROM pd_fts WHERE user_id=?').get(f.a.userId)!.n),ftsBefore);
  assert.ok(a.data.readMaterial(a.parent.id).text.includes('synthetic A'));assert.ok(!JSON.stringify(a.data.search({query:'synthetic B'})).includes('synthetic B'));
  assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
});

test('restore rejects unsupported envelopes, schema extensions and a nonempty different target without mutations',async t=>{
  const f=fixture(t);f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  const archive=await f.lifecycle.exportUser(f.a),aBefore=hash(archive),bBefore=hash(await f.lifecycle.exportUser(f.b));
  const changes=[
    (v:any)=>{v.version=2;},(v:any)=>{v.domain='another-domain';},(v:any)=>{v.deploymentId='another-deployment';},(v:any)=>{v.userId=f.b.userId;},
    (v:any)=>{v.extra=true;},(v:any)=>{v.payload.userId=f.b.userId;},(v:any)=>{v.payload.sources[0].user_id=f.b.userId;},
    (v:any)=>{v.payload.coverage.excluded=[];},(v:any)=>{delete v.payload.material_sources;},
    (v:any)=>{v.payload.materials[0].min_visible_sequence=0;},
    (v:any)=>{v.payload.materials[0].min_visible_sequence=v.payload.materials[0].sequence+2;},
  ];
  for(const mutate of changes){const bad=copy(archive);mutate(bad);await assert.rejects(f.lifecycle.restoreUser(f.a,bad,'bad-restore'),{code:'invalid_data'});}
  const different=copy(archive),source=JSON.parse((different.payload as any).sources[0].json);source.name='A different valid name';(different.payload as any).sources[0].json=JSON.stringify(source);
  await assert.rejects(f.lifecycle.restoreUser(f.a,different,'nonempty'),{code:'conflict',statusCode:409});
  assert.equal(hash(await f.lifecycle.exportUser(f.a)),aBefore);assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
});

test('restore validates canonical JSON, fingerprints, revisions, duplicate rows and all local references before writing',async t=>{
  const f=fixture(t);f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  f.repository(f.b).registerSource({id:'b-only-source',name:'synthetic B only',kind:'custom',deviceId:'same-device',platform:'import'});
  f.repository(f.b).receiveCaptures([{id:bOnlyCapture,deviceId:'same-device',deviceName:'Fixture',platform:'import',capturedAt:at,durationMs:0,ocrText:'synthetic B only note',source:'note'}]);
  const archive=await f.lifecycle.exportUser(f.a),bBefore=hash(await f.lifecycle.exportUser(f.b));await f.lifecycle.deleteUser(f.a,'delete-before-bad-restore');
  const empty=hash(await f.lifecycle.exportUser(f.a));
  const corruptions=[
    (p:any)=>{p.sources[0].json='{';},
    (p:any)=>{const value=JSON.parse(p.sources[0].json);value.extra='not in the source schema';p.sources[0].json=JSON.stringify(value);},
    (p:any)=>{p.captures[0].fingerprint='0'.repeat(64);},
    (p:any)=>{p.source_contexts[0].description='changed without fingerprint';},
    (p:any)=>{p.material_versions[0].text='changed without original draft';},
    (p:any)=>{const value=JSON.parse(p.material_versions[0].json);value.title='changed without revision';p.material_versions[0].json=JSON.stringify(value);},
    (p:any)=>{p.sources.push(copy(p.sources[0]));},
    (p:any)=>{p.material_captures[0].capture_id=bOnlyCapture;},
    (p:any)=>{p.material_inputs[0].input_revision='f'.repeat(64);},
    (p:any)=>{p.material_contexts[0].source_id='b-only-source';},
    (p:any)=>{p.source_heads[0].capture_id=bOnlyCapture;},
    (p:any)=>{p.material_sources.pop();},
    (p:any)=>{p.material_sources.push({...p.material_sources[0],source_id:'b-only-source'});},
    (p:any)=>{p.material_contexts[0].version=1;},
  ];
  for(const mutate of corruptions){
    const bad=copy(archive);mutate(bad.payload);await assert.rejects(f.lifecycle.restoreUser(f.a,bad,'bad-data'),{code:'invalid_data'});
    assert.equal(hash(await f.lifecycle.exportUser(f.a)),empty);assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
    assert.equal(Number(f.db.prepare('SELECT COUNT(*) n FROM pd_fts WHERE user_id=?').get(f.a.userId)!.n),0);
  }
  await f.lifecycle.restoreUser(f.a,archive,'valid-after-failures');assert.deepEqual(await f.lifecycle.exportUser(f.a),archive);
});

test('a consistently rehashed Material cannot restore a reference existing only in B',async t=>{
  const f=fixture(t);f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  const a=await f.lifecycle.exportUser(f.a),b=f.repository(f.b),bOnly=b.publishMaterial({id:materialId('b-only'),kind:'mote.document',schemaVersion:1,title:'synthetic B only',origin:{sourceId:'same-source',externalId:'b-only'},blocks:[],members:[],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const bBefore=hash(await f.lifecycle.exportUser(f.b));await f.lifecycle.deleteUser(f.a,'delete-a');
  const bad=copy(a),p=bad.payload as any,child=p.materials.find((row:any)=>row.id===materialId('child')),version=p.material_versions.find((row:any)=>row.material_id===child.id);
  const old=version.revision,draft=JSON.parse(version.json);draft.members[0].ref=bOnly.ref;draft.members[0].revision=bOnly.revision;
  const parsed=materialDraftSchema.parse(draft),revision=hash(parsed);version.json=JSON.stringify(parsed);version.revision=revision;child.revision=revision;
  for(const name of ['material_captures','material_inputs','material_contexts','material_sources'])for(const row of p[name])if(row.material_id===child.id&&row.revision===old)row.revision=revision;
  const link=p.material_inputs.find((row:any)=>row.material_id===child.id);link.input_material_id=bOnly.id;link.input_revision=bOnly.revision;
  await assert.rejects(f.lifecycle.restoreUser(f.a,bad,'cross-user-reference'),{code:'invalid_data'});
  assert.deepEqual(f.repository(f.a).statistics(),{sources:0,captures:0,materials:0});assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
});

test('restore and delete failures roll back canonical rows and trigger-managed FTS as one transaction',async t=>{
  const f=fixture(t);f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  const archive=await f.lifecycle.exportUser(f.a),bBefore=hash(await f.lifecycle.exportUser(f.b));
  f.fail(sql=>sql.startsWith('DELETE FROM pd_captures'));
  await assert.rejects(f.lifecycle.deleteUser(f.a,'failed-delete'),/synthetic transaction failure/);f.fail();
  assert.deepEqual(await f.lifecycle.exportUser(f.a),archive);
  assert.ok(Number(f.db.prepare('SELECT COUNT(*) n FROM pd_fts WHERE user_id=?').get(f.a.userId)!.n)>0);
  await f.lifecycle.deleteUser(f.a,'delete-a');
  f.fail(sql=>sql.startsWith('INSERT INTO pd_material_versions'));
  await assert.rejects(f.lifecycle.restoreUser(f.a,archive,'failed-restore'),/synthetic transaction failure/);f.fail();
  assert.deepEqual(f.repository(f.a).statistics(),{sources:0,captures:0,materials:0});
  assert.equal(Number(f.db.prepare('SELECT COUNT(*) n FROM pd_fts WHERE user_id=?').get(f.a.userId)!.n),0);
  assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
  await f.lifecycle.restoreUser(f.a,archive,'successful-retry');assert.deepEqual(await f.lifecycle.exportUser(f.a),archive);
});

test('cross-source captures, block attribution and transitive Material source pins round-trip exactly',async t=>{
  const f=fixture(t),{data}=f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  const bBefore=hash(await f.lifecycle.exportUser(f.b));
  data.registerSource({id:'aux-source',name:'synthetic A auxiliary',kind:'custom',deviceId:'aux-device',platform:'import'});
  data.registerSource({id:'relation-source',name:'synthetic A attribution',kind:'custom',deviceId:'relation-device',platform:'import',ownerRelation:'mixed'});
  const context=data.updateSourceContext('aux-source',{expectedVersion:0,description:'synthetic A auxiliary context'});
  const capture=data.receiveSourceItems('aux-source',[{externalId:'aux-document',revision:'aux-v1',observedAt:at,title:'A auxiliary document',text:'A auxiliary original',kind:'file',layer:'original',document:{recordedAt:'2025-12-31T12:00:00+02:00'}}]).receipts[0].id;
  const parent=data.publishMaterial({id:materialId('cross-source'),kind:'mote.document',schemaVersion:1,title:'A cross-source Material',origin:{sourceId:'same-source',externalId:'cross-source'},
    attributionContext:{version:1,ownerRelation:'mixed',basis:'owner_source',sourceDeclaration:{sourceId:'relation-source',version:1,ownerRelation:'mixed'}},
    blocks:[{id:'cross',kind:'text',format:'plain',text:'A cross-source text',memberIds:['aux'],evidenceIds:[capture],
      evidenceContext:{observedAt:at,document:{timeBasis:'recorded',recordedAt:'2025-12-31T12:00:00+02:00'},attributionContext:{version:1,ownerRelation:'unknown',basis:'default',
        sourceContextDeclarations:[{sourceId:'aux-source',version:context.version,fingerprint:context.fingerprint}],sourceContextStatements:[{sourceId:'aux-source',version:context.version,description:context.description}]}}}],
    members:[{id:'aux',kind:'capture',ref:'capture:'+capture,revision:'aux-v1'}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const child=data.publishMaterial({id:materialId('cross-source-child'),kind:'mote.document',schemaVersion:1,title:'A transitive child',origin:{sourceId:'same-source',externalId:'cross-source-child'},
    blocks:[],members:[{id:'parent',kind:'material',ref:parent.ref,revision:parent.revision}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const archive=await f.lifecycle.exportUser(f.a),payload=archive.payload as any;
  assert.deepEqual(payload.material_sources.filter((row:any)=>row.material_id===child.id).map((row:any)=>row.source_id).sort(),['aux-source','relation-source','same-source']);
  assert.equal(payload.captures.find((row:any)=>row.id===capture).context_at,'2025-12-31T10:00:00.000Z');
  await f.lifecycle.deleteUser(f.a,'delete-cross-source');await f.lifecycle.restoreUser(f.a,archive,'restore-cross-source');
  assert.deepEqual(await f.lifecycle.exportUser(f.a),archive);assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
  data.deleteSource('aux-source');assert.throws(()=>data.material(parent.id),{code:'not_found'});assert.throws(()=>data.material(child.id),{code:'not_found'});
  await f.lifecycle.exportUser(f.a);assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
});

test('context refresh retains body, correction and historical pins through visible and hidden archive round-trips',async t=>{
  const f=fixture(t),a=f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  const bBefore=hash(await f.lifecycle.exportUser(f.b)),originalText=a.data.readMaterial(a.parent.id).text;
  const corrected=a.data.correctMaterialContext(a.parent.id,a.parent.revision,'third_party');
  const description=a.data.updateSourceContext('same-source',{expectedVersion:2,description:'synthetic A revised context'});
  let current=a.data.material(a.parent.id);
  assert.equal(a.data.readMaterial(a.parent.id).text,originalText);assert.equal(current.attributionContext?.correction?.ownerRelation,'third_party');
  assert.ok(current.sequence>corrected.sequence);assert.throws(()=>a.data.material(a.parent.id,a.parent.revision),{code:'not_found'});
  a.data.updateSource('same-source',{ownerRelation:'mixed'});current=a.data.material(a.parent.id);
  assert.equal(current.attributionContext?.ownerRelation,'third_party');assert.equal(current.attributionContext?.correction?.version,1);
  assert.equal(current.attributionContext?.sourceDeclaration?.ownerRelation,'mixed');
  const visible=await f.lifecycle.exportUser(f.a),p=visible.payload as any,head=p.materials.find((row:any)=>row.id===a.parent.id);
  assert.equal(head.min_visible_sequence,head.sequence);
  const history=p.material_versions.filter((row:any)=>row.material_id===a.parent.id).sort((a:any,b:any)=>a.sequence-b.sequence);
  assert.ok(history.length>=5);assert.deepEqual(history.map((row:any)=>row.sequence),Array.from({length:history.length},(_,index)=>index+1));
  assert.ok(p.material_contexts.some((row:any)=>row.material_id===a.parent.id&&row.version===2));
  assert.ok(p.material_contexts.some((row:any)=>row.material_id===a.parent.id&&row.version===description.version));
  assert.ok(history.some((row:any)=>JSON.parse(row.json).attributionContext.sourceDeclaration.ownerRelation==='owner'));
  await f.lifecycle.deleteUser(f.a,'delete-visible-history');await f.lifecycle.restoreUser(f.a,visible,'restore-visible-history');
  assert.deepEqual(await f.lifecycle.exportUser(f.a),visible);assert.equal(a.data.readMaterial(a.parent.id).text,originalText);
  const received=a.data.receiveSourceItems('same-source',[{externalId:'same-external',revision:'same-version-2',observedAt:'2026-01-02T00:00:00.000Z',title:'synthetic A newer original',text:'synthetic A newer source body',kind:'file',layer:'original'}]).receipts[0];
  assert.throws(()=>a.data.material(a.parent.id),{code:'not_found'});assert.throws(()=>a.data.material(a.child.id),{code:'not_found'});
  const hidden=await f.lifecycle.exportUser(f.a),hiddenPayload=hidden.payload as any,hiddenHead=hiddenPayload.materials.find((row:any)=>row.id===a.parent.id);
  assert.equal(hiddenHead.min_visible_sequence,hiddenHead.sequence+1);
  assert.equal(hiddenPayload.material_versions.filter((row:any)=>row.material_id===a.parent.id).length,history.length);
  await f.lifecycle.deleteUser(f.a,'delete-hidden-history');await f.lifecycle.restoreUser(f.a,hidden,'restore-hidden-history');
  assert.deepEqual(await f.lifecycle.exportUser(f.a),hidden);
  assert.throws(()=>a.data.material(a.parent.id),{code:'not_found'});
  assert.equal(a.data.search({query:'synthetic A processed'}).items.some(row=>row.kind==='material'),false);
  const draft=JSON.parse(hiddenPayload.material_versions.find((row:any)=>row.material_id===a.parent.id&&row.revision===hiddenHead.revision).json);
  const original=draft.members.find((member:any)=>member.id==='original');original.ref='capture:'+received.id;original.revision=received.revision;
  for(const block of draft.blocks)if(block.evidenceIds)block.evidenceIds=block.evidenceIds.map((id:string)=>id===a.sourceCapture?received.id:id);
  const rebuilt=a.data.publishMaterial(draft,hiddenHead.revision);
  assert.equal(rebuilt.attributionContext?.correction?.ownerRelation,'third_party');assert.equal(a.data.readMaterial(rebuilt.id).text,originalText);
  const childHead=hiddenPayload.materials.find((row:any)=>row.id===a.child.id),childDraft=JSON.parse(hiddenPayload.material_versions.find((row:any)=>row.material_id===a.child.id&&row.revision===childHead.revision).json);
  childDraft.members[0].ref=rebuilt.ref;childDraft.members[0].revision=rebuilt.revision;
  assert.throws(()=>a.data.publishMaterial(childDraft,childHead.revision),{code:'conflict'});
  // A rebuild derives fresh descriptions through the host publication path.
  delete childDraft.attributionContext.sourceDeclaration;
  delete childDraft.attributionContext.sourceContextDeclarations;
  a.data.publishMaterial(childDraft,childHead.revision);
  const rebuiltArchive=await f.lifecycle.exportUser(f.a);
  await f.lifecycle.deleteUser(f.a,'delete-rebuilt');await f.lifecycle.restoreUser(f.a,rebuiltArchive,'restore-rebuilt');
  assert.deepEqual(await f.lifecycle.exportUser(f.a),rebuiltArchive);assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
});

test('historical revisions keep distinct creation times while the current head retains its own update time',async t=>{
  const f=fixture(t),a=f.seed(f.a,'synthetic A');f.seed(f.b,'synthetic B');
  const archive=await f.lifecycle.exportUser(f.a),payload=archive.payload as any,bBefore=hash(await f.lifecycle.exportUser(f.b));
  // Give the synthetic historical records deterministic, distinct timestamps;
  // no wall-clock timing assumption should be needed to validate a sequence.
  for(const [index,head] of payload.materials.entries()){
    const history=payload.material_versions.filter((row:any)=>row.material_id===head.id).sort((a:any,b:any)=>a.sequence-b.sequence);
    for(const version of history)version.created_at=new Date(Date.UTC(2026,1,index*10+version.sequence)).toISOString();
    head.created_at=history[0].created_at;
    head.updated_at=new Date(Date.parse(history.at(-1).created_at)+60_000).toISOString();
  }
  await f.lifecycle.deleteUser(f.a,'delete-timestamp-fixture');await f.lifecycle.restoreUser(f.a,archive,'restore-timestamp-fixture');
  assert.deepEqual(await f.lifecycle.exportUser(f.a),archive);
  const head=payload.materials.find((row:any)=>row.id===a.parent.id),history=payload.material_versions.filter((row:any)=>row.material_id===head.id).sort((a:any,b:any)=>a.sequence-b.sequence);
  assert.notEqual(history[0].created_at,history.at(-1).created_at);
  assert.equal(a.data.material(a.parent.id,history[0].revision).createdAt,history[0].created_at);
  assert.equal(a.data.material(a.parent.id).createdAt,history.at(-1).created_at);
  assert.equal(a.data.material(a.parent.id).updatedAt,head.updated_at);
  assert.equal(hash(await f.lifecycle.exportUser(f.b)),bBefore);
});
