import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildApp} from '../src/app.js';
import {openScopeStorage} from '../src/scope/storage.js';
import {PrivateData,PRIVATE_DATA_DOMAIN} from '../src/scope/private-data.js';
import {LifecycleAuthority} from '../src/scope/lifecycle.js';
import {twoUsers} from './fixtures/two-users.js';
import {privateSqlViolations,checkPrivateDataSql} from '../../../scripts/check-scope-contracts.mjs';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source=(id='same-source')=>({id,name:'Generated source',kind:'custom',deviceId:'same-device',platform:'import'});
const item=(externalId='same-external',text='Generated shared text',revision='same-version')=>({externalId,revision,observedAt:'2026-01-01T00:00:00Z',title:'Generated fixture',text,kind:'file',layer:'original'});
const draft=(sourceId='same-source',externalId='same-external',text='Generated material',captureId?:string)=>({
  id:'mat_'+hash([sourceId,externalId]),kind:'document',schemaVersion:1,title:'Generated title',origin:{sourceId,externalId,deviceId:'same-device'},
  blocks:[{id:'text',kind:'text',format:'plain',text,memberIds:captureId?['original']:[]}],
  members:captureId?[{id:'original',kind:'capture',ref:'capture:'+captureId}]:[],
  coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'},
});
async function fixture(t:any){
  const dir=mkdtempSync(join(tmpdir(),'mote-m02-')),storage=openScopeStorage(dir),id=storage.deploymentId;storage.close();
  const identities=twoUsers(id);
  const grants=new Map<string,any>();
  const lifecycleAuthority=new LifecycleAuthority(id,{verify:async grant=>grants.get(grant),isCurrent:c=>grants.has(c.operationId)});
  const node=await buildApp({dataDir:dir},{verifier:identities.verifier,lifecycleAuthority});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const aContext=await node.authority.authenticate('generated-a'),bContext=await node.authority.authenticate('generated-b');
  const a=node.services.forUser(aContext).get<PrivateData>(PRIVATE_DATA_DOMAIN),b=node.services.forUser(bContext).get<PrivateData>(PRIVATE_DATA_DOMAIN);
  const request=async(token:string,url:string,method:any='GET',payload?:unknown)=>node.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-protocol-version':'2'},...(payload===undefined?{}:{payload})});
  return {dir,id,node,identities,grants,lifecycleAuthority,a,b,aContext,bContext,request};
}

test('production data routes bind source identities, reject spoofing and keep unimplemented intake closed',async t=>{
  const f=await fixture(t);
  for(const token of ['generated-a','generated-b'])assert.equal((await f.request(token,'/api/sources','POST',source())).statusCode,200);
  f.b.registerSource(source('b-only'));
  assert.deepEqual((await f.request('generated-a','/api/sources')).json().items.map((s:any)=>s.id),['same-source']);
  for(const [method,payload] of [['GET',undefined],['PATCH',{name:'attempt'}],['DELETE',undefined]] as const){
    const denied=await f.request('generated-a','/api/sources/b-only',method,payload),unknown=await f.request('generated-a','/api/sources/missing',method,payload);
    assert.equal(denied.statusCode,404);assert.deepEqual(denied.json(),unknown.json());
  }
  for(const url of ['/api/sources/b-only/context','/api/sources/b-only/items','/api/sources/b-only/item?externalId=x','/api/sources/b-only/history?externalId=x','/api/captures?sourceId=b-only'])assert.equal((await f.request('generated-a',url)).statusCode,404,url);
  for(const url of ['/api/captures?userId=generated-user-b','/api/sources?ownerId=generated-user-b'])assert.equal((await f.request('generated-a',url)).statusCode,401);
  assert.equal((await f.node.app.inject({url:'/api/sources',headers:{'x-user-id':'generated-user-a'}})).statusCode,401);
  assert.equal((await f.request('old-owner-token','/api/sources')).statusCode,401);
  assert.equal((await f.request('generated-a','/api/sources','POST',{...source('spoof'),userId:'generated-user-b'})).statusCode,401);
  for(const url of ['/api/sources/same-source/items','/api/captures','/api/file-sync/batches','/api/materials','/api/memory','/api/ask'])assert.equal((await f.request('generated-a',url,'PUT',{})).statusCode,503,url);
  assert.equal(f.b.source('b-only').name,'Generated source');
});

test('same source/external/revision/capture/material identities coexist; B detail, counts and mutation do not leak',async t=>{
  const f=await fixture(t);f.a.registerSource(source());f.b.registerSource(source());f.b.registerSource(source('b-only'));
  const a=f.a.receiveSourceItems('same-source',[item('same-external','A content')]).receipts[0],b=f.b.receiveSourceItems('same-source',[item('same-external','B secret')]).receipts[0];
  assert.equal(a.id,b.id);assert.equal(f.a.capture(a.id).ocrText,'A content');assert.equal(f.b.capture(b.id).ocrText,'B secret');
  const am=f.a.publishMaterial(draft()),bm=f.b.publishMaterial(draft());assert.equal(am.id,bm.id);assert.equal(am.revision,bm.revision);
  const only=f.b.receiveSourceItems('b-only',[item('b-only','B exclusive')]).receipts[0];
  const material=f.b.publishMaterial(draft('b-only','b-only','B exclusive',only.id));
  for(const url of [`/api/captures/${only.id}`,`/api/materials/${material.id}`,`/api/materials/${material.id}/read`,`/api/materials/${material.id}/members`,`/api/materials/${material.id}/revisions/${material.revision}`]){
    const response=await f.request('generated-a',url);assert.equal(response.statusCode,404,url);assert.equal(response.body.includes('exclusive'),false);
  }
  assert.deepEqual((await f.request('generated-a','/api/data/statistics')).json(),{sources:1,captures:1,materials:1});
  assert.equal((await f.request('generated-a',`/api/captures/${only.id}`,'DELETE')).statusCode,404);
  assert.equal((await f.request('generated-a',`/api/materials/${material.id}`,'DELETE')).statusCode,404);
  assert.equal((await f.request('generated-a',`/api/materials/${material.id}/context`,'PATCH',{expectedRevision:material.revision,ownerRelation:'owner'})).statusCode,404);
  const corrected=await f.request('generated-a',`/api/materials/${am.id}/context`,'PATCH',{expectedRevision:am.revision,ownerRelation:'owner'});assert.equal(corrected.statusCode,200);assert.notEqual(corrected.json().revision,am.revision);
  assert.equal(f.b.material(bm.id).revision,bm.revision);
  assert.equal((await f.request('generated-a',`/api/materials/${am.id}/context`,'PATCH',{expectedRevision:am.revision,ownerRelation:'third_party'})).statusCode,409);
  assert.equal((await f.request('generated-a',`/api/captures/${a.id}`,'DELETE')).statusCode,200);assert.equal(f.b.capture(b.id).ocrText,'B secret');
});

test('durable signed cursors reject account, filter, collection and tampering replays, then survive restart',async t=>{
  const f=await fixture(t);for(const store of [f.a,f.b]){store.registerSource(source());store.receiveSourceItems('same-source',[item('one'),item('two'),item('three')]);}
  const first=(await f.request('generated-a','/api/captures?limit=1')).json();assert.equal(first.items.length,1);assert.ok(first.nextCursor);
  const query=encodeURIComponent(first.nextCursor);
  assert.equal((await f.request('generated-b','/api/captures?limit=1&cursor='+query)).statusCode,400);
  assert.equal((await f.request('generated-a','/api/source-items?limit=1&cursor='+query)).statusCode,400);
  assert.equal((await f.request('generated-a','/api/captures?kind=file&cursor='+query)).statusCode,400);
  assert.equal((await f.request('generated-a','/api/captures?cursor='+query+'x')).statusCode,400);
  let cursor=first.nextCursor;const ids=[first.items[0].id];while(cursor){const page=(await f.request('generated-a','/api/captures?limit=1&cursor='+encodeURIComponent(cursor))).json();ids.push(...page.items.map((r:any)=>r.id));cursor=page.nextCursor;}assert.equal(new Set(ids).size,3);
  await f.node.app.close();
  const restarted=await buildApp({dataDir:f.dir},{verifier:f.identities.verifier});t.after(()=>restarted.app.close());
  const page=await restarted.app.inject({url:'/api/captures?limit=1&cursor='+query,headers:{authorization:'Bearer generated-a','x-mote-protocol-version':'2'}});assert.equal(page.statusCode,200);assert.notEqual(page.json().items[0].id,first.items[0].id);
});

test('FTS and short CJK candidates isolate before LIMIT and downstream model/reranker input',async t=>{
  const f=await fixture(t);f.a.registerSource(source());f.b.registerSource(source());
  f.a.receiveSourceItems('same-source',[item('z-a','commonterm 中文 A generated')]);
  f.b.receiveSourceItems('same-source',Array.from({length:100},(_,i)=>item('a-b-'+i,'commonterm 中文 B_UNIQUE_SECRET')));
  f.b.publishMaterial(draft('same-source','b-only','B_UNIQUE_SECRET 中文'));
  for(const query of ['commonterm','中文','B_UNIQUE_SECRET','" OR *']){
    const response=await f.request('generated-a','/api/data/search?limit=1&query='+encodeURIComponent(query));assert.equal(response.statusCode,200);
    const candidates=response.json().items;
    // This is the complete input a later model/reranker is allowed to consume.
    assert.equal(JSON.stringify(candidates).includes('B_UNIQUE_SECRET'),false);
    assert.equal(candidates.length,query==='commonterm'||query==='中文'?1:0);
  }
  assert.equal(f.b.search({query:'B_UNIQUE_SECRET',limit:200}).items.length,101);
});

test('composite FKs and atomic transactions reject cross-user parents and leave no partial captures/material/FTS',async t=>{
  const f=await fixture(t);f.a.registerSource(source());f.b.registerSource(source('b-only'));
  const b=f.b.receiveSourceItems('b-only',[item('only','B private')]).receipts[0];
  assert.throws(()=>f.a.receiveSourceItems('b-only',[item()]),{code:'not_found'});
  assert.throws(()=>f.a.publishMaterial(draft('same-source','attempt','attempt',b.id)),{code:'not_found'});
  assert.equal(f.a.statistics().materials,0);assert.equal(f.a.search({query:'attempt'}).items.length,0);
  f.a.receiveSourceItems('same-source',[item('existing','Original')]);
  assert.throws(()=>f.a.receiveSourceItems('same-source',[item('new','Partial text'),item('existing','Changed')] ),{code:'conflict'});
  assert.equal(f.a.statistics().captures,1);assert.equal(f.a.search({query:'Partial'}).items.length,0);assert.equal(f.a.sourceItem('same-source','new'),null);
  const db=new DatabaseSync(join(f.dir,'mote.sqlite'));t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');
  assert.throws(()=>db.prepare('INSERT INTO pd_captures VALUES(?,?,?,?,?,?,?,?,?)').run('generated-user-a',randomUUID(),'b-only','external','revision','fingerprint','2026-01-01','2026-01-01','{}'),/FOREIGN KEY/);
  const m=f.a.publishMaterial(draft());
  assert.throws(()=>db.prepare('INSERT INTO pd_material_captures VALUES(?,?,?,?,?)').run('generated-user-a',m.id,m.revision,'cross',b.id),/FOREIGN KEY/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('exact dependencies, source context optimistic updates and cascading invalidation stay in A',async t=>{
  const f=await fixture(t);for(const store of [f.a,f.b]){store.registerSource(source());store.updateSourceContext('same-source',{expectedVersion:0,description:'Generated source declaration'});}
  const c=f.a.receiveSourceItems('same-source',[item()]).receipts[0];
  const m=f.a.publishMaterial(draft('same-source','original','Material source',c.id)),bm=f.b.publishMaterial(draft());
  const derived={...draft('same-source','derived'),members:[{id:'parent',kind:'material',ref:m.ref}]};f.a.publishMaterial(derived);
  const fake={...draft('same-source','bad'),members:[{id:'parent',kind:'material',ref:`material:${m.id}@${'f'.repeat(64)}`}]};assert.throws(()=>f.a.publishMaterial(fake),{code:'not_found'});
  const response=await f.request('generated-a','/api/sources/same-source/context','PATCH',{expectedVersion:1,description:'New generated declaration'});assert.equal(response.statusCode,200);
  assert.equal(f.a.statistics().materials,2);assert.notEqual(f.a.material(m.id).revision,m.revision);assert.throws(()=>f.a.material(m.ref),{code:'not_found'});assert.equal(f.b.material(bm.id).revision,bm.revision);assert.equal(f.b.sourceContext('same-source').description,'Generated source declaration');
  assert.equal((await f.request('generated-a','/api/sources/same-source/context','PATCH',{expectedVersion:0,description:'stale'})).statusCode,409);
  assert.equal((await f.request('generated-a','/api/sources/same-source/context?version=1')).json().description,'Generated source declaration');
  assert.deepEqual(f.a.updateSourceContext('same-source',{expectedVersion:1,description:'New generated declaration'}),response.json());
});

test('source control-plane edits preserve Material content and owner corrections across blocks and later rebuilds',async t=>{
  const f=await fixture(t);for(const store of [f.a,f.b])store.registerSource({...source(),ownerRelation:'owner'});
  const receipt=f.a.receiveSourceItems('same-source',[item()]).receipts[0];
  const input=draft('same-source','same-external','Generated processed body',receipt.id);
  (input.blocks[0] as any).evidenceContext={observedAt:'2026-01-01T00:00:00Z',document:{timeBasis:'unknown',contentRole:'authored'},attributionContext:{version:1,ownerRelation:'unknown',basis:'default'}};
  const first=f.a.publishMaterial(input),b=f.b.publishMaterial(draft());
  const corrected=f.a.correctMaterialContext(first.id,first.revision,'third_party');
  assert.equal(f.a.readMaterial(first.id).spans[0].attributionContext?.ownerRelation,'third_party');
  f.a.updateSourceContext('same-source',{expectedVersion:0,description:'Generated new source description'});
  const refreshed=f.a.material(first.id);assert.notEqual(refreshed.revision,corrected.revision);assert.equal(refreshed.sequence,corrected.sequence+1);
  assert.equal(refreshed.attributionContext?.ownerRelation,'third_party');assert.deepEqual(refreshed.attributionContext?.correction,corrected.attributionContext?.correction);
  assert.equal(refreshed.attributionContext?.sourceContextDeclarations?.[0].version,1);assert.equal(f.a.readMaterial(first.id).text,'Generated processed body');
  assert.throws(()=>f.a.material(corrected.ref),{code:'not_found'});
  f.a.updateSource('same-source',{ownerRelation:'mixed'});assert.equal(f.a.material(first.id).attributionContext?.ownerRelation,'third_party');assert.equal(f.a.readMaterial(first.id).spans[0].attributionContext?.ownerRelation,'third_party');
  const next=f.a.receiveSourceItems('same-source',[{...item(),revision:'next-version',observedAt:'2026-01-02T00:00:00Z'}]).receipts[0];
  assert.equal(f.a.statistics().materials,0);assert.throws(()=>f.a.material(first.id),{code:'not_found'});
  const rebuilt=f.a.publishMaterial(draft('same-source','same-external','New processed body',next.id));assert.equal(rebuilt.attributionContext?.ownerRelation,'third_party');assert.ok(rebuilt.sequence>refreshed.sequence);
  assert.equal(f.b.material(b.id).revision,b.revision);
  const archive=await f.node.services.forUser(f.aContext).exportUser(PRIVATE_DATA_DOMAIN);assert.ok((archive.payload as any).material_versions.length>=4);
});

test('source item calendar filters preserve timezone-aware planned interval overlap within the owner',async t=>{
  const f=await fixture(t);for(const store of [f.a,f.b])store.registerSource(source());
  const calendar={...item(),kind:'calendar',calendar:{start:'2026-11-02T07:30:00+08:00',end:'2026-11-02T08:30:00+08:00',allDay:false}};
  f.a.receiveSourceItems('same-source',[calendar]);f.b.receiveSourceItems('same-source',[{...calendar,externalId:'b-only',text:'B secret calendar'}]);
  const url='/api/source-items?after='+encodeURIComponent('2026-11-01T23:00:00Z')+'&before='+encodeURIComponent('2026-11-02T01:00:00Z');
  const response=await f.request('generated-a',url);assert.equal(response.statusCode,200);assert.equal(response.json().items.length,1);assert.equal(response.body.includes('B secret'),false);
  assert.equal((await f.request('generated-a','/api/captures?after=2026-11-01T23:00:00Z')).json().items.length,0);
});

test('publication refuses a newly withdrawn input and does not invalidate unrelated current heads from historical links',async t=>{
  const f=await fixture(t);f.a.registerSource(source());f.b.registerSource(source());
  const a1=f.a.publishMaterial(draft('same-source','a','A1'));
  const dependent={...draft('same-source','b','B1'),members:[{id:'a',kind:'material',ref:a1.ref}]};
  const b1=f.a.publishMaterial(dependent),before=await f.node.services.forUser(f.aContext).exportUser(PRIVATE_DATA_DOMAIN);
  assert.throws(()=>f.a.publishMaterial({...draft('same-source','a','A2'),members:[{id:'b',kind:'material',ref:b1.ref}]},a1.revision),{code:'conflict'});
  assert.equal(f.a.material(a1.id).revision,a1.revision);assert.equal(f.a.material(b1.id).revision,b1.revision);
  assert.deepEqual(await f.node.services.forUser(f.aContext).exportUser(PRIVATE_DATA_DOMAIN),before);
  const b2=f.a.publishMaterial(draft('same-source','b','Independent B2'),b1.revision);
  f.a.publishMaterial(draft('same-source','a','Independent A2'),a1.revision);
  assert.equal(f.a.material(b2.id).revision,b2.revision);
  const old=f.a.receiveSourceItems('same-source',[item('old-source')]).receipts[0],other=f.a.receiveSourceItems('same-source',[item('other-source')]).receipts[0];
  const oldProjection=f.a.publishMaterial(draft('same-source','capture-derived','Old projection',old.id));
  const newProjection=f.a.publishMaterial(draft('same-source','capture-derived','Independent new projection',other.id),oldProjection.revision);
  f.a.receiveSourceItems('same-source',[{...item('old-source'),revision:'next',observedAt:'2026-01-03T00:00:00Z'}]);
  assert.equal(f.a.material(newProjection.id).revision,newProjection.revision);
  await f.node.services.forUser(f.aContext).exportUser(PRIVATE_DATA_DOMAIN);
});

test('multiple SQLite connections and authority revocation preserve ownership at read and commit',async t=>{
  const f=await fixture(t),second=await buildApp({dataDir:f.dir},{verifier:f.identities.verifier});t.after(()=>second.app.close());
  const a2=second.services.forUser(await second.authority.authenticate('generated-a')).get<PrivateData>(PRIVATE_DATA_DOMAIN);
  f.a.registerSource(source());f.b.registerSource(source());a2.receiveSourceItems('same-source',[item('same','A connection 2')]);f.b.receiveSourceItems('same-source',[item('same','B connection 1')]);
  assert.equal(f.a.sourceItem('same-source','same')?.text,'A connection 2');assert.equal(f.b.sourceItem('same-source','same')?.text,'B connection 1');
  assert.throws(()=>second.services.forUser(f.aContext),{code:'invalid_identity'});
  f.identities.disabled.add('generated-user-a');
  assert.throws(()=>a2.sources(),{code:'invalid_identity'});assert.throws(()=>f.a.registerSource(source('revoked')),{code:'invalid_identity'});
  assert.equal((await f.request('generated-a','/api/data/statistics')).statusCode,401);assert.equal((await f.request('generated-b','/api/data/statistics')).statusCode,200);
});

test('production lifecycle grants export/delete/restore a disabled account without enabling private access',async t=>{
  const f=await fixture(t);for(const store of [f.a,f.b]){store.registerSource(source());const c=store.receiveSourceItems('same-source',[item()]).receipts[0];store.publishMaterial(draft('same-source','same-external','Generated data',c.id));}
  const archive=await f.node.services.forUser(f.aContext).exportUser(PRIVATE_DATA_DOMAIN),beforeB=await f.node.services.forUser(f.bContext).exportUser(PRIVATE_DATA_DOMAIN);
  f.identities.disabled.add(f.aContext.userId);
  for(const purpose of ['export','delete','restore'] as const){const operationId=purpose+'-a';f.grants.set(operationId,{deploymentId:f.id,userId:f.aContext.userId,domain:PRIVATE_DATA_DOMAIN,purpose,operationId});}
  const grant=async(purpose:string)=>f.lifecycleAuthority.authorize(purpose+'-a');
  assert.deepEqual(await f.node.services.forLifecycle(await grant('export')).run(),archive);
  assert.deepEqual(await f.node.services.forLifecycle(await grant('delete')).run(),{status:'complete',operationId:'delete-a'});
  assert.deepEqual(await f.node.services.forLifecycle(await grant('delete')).run(),{status:'complete',operationId:'delete-a'});
  await f.node.services.forLifecycle(await grant('restore')).run(archive);
  await f.node.services.forLifecycle(await grant('restore')).run(archive);
  assert.deepEqual(await f.node.services.forLifecycle(await grant('export')).run(),archive);
  assert.deepEqual(await f.node.services.forUser(f.bContext).exportUser(PRIVATE_DATA_DOMAIN),beforeB);
  assert.throws(()=>f.a.sources(),{code:'invalid_identity'});
  const context=await grant('delete');f.grants.delete('delete-a');assert.throws(()=>f.node.services.forLifecycle(context),{code:'invalid_identity'});
  f.grants.set('wrong-domain',{deploymentId:f.id,userId:f.aContext.userId,domain:'other-domain',purpose:'delete',operationId:'wrong-domain'});
  const wrong=await f.lifecycleAuthority.authorize('wrong-domain');assert.throws(()=>f.node.services.assertSubject(wrong,PRIVATE_DATA_DOMAIN,'delete'),{code:'invalid_identity'});
});

test('revocation at the transaction commit fence rolls back the private write',async t=>{
  const f=await fixture(t),current=f.identities.verifier.isCurrent;let checks=0;
  f.identities.verifier.isCurrent=identity=>{if(++checks===4)f.identities.disabled.add(identity.userId);return current(identity);};
  assert.throws(()=>f.a.registerSource(source('must-rollback')),{code:'invalid_identity'});
  const db=new DatabaseSync(join(f.dir,'mote.sqlite'),{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM pd_sources WHERE id='must-rollback'").get()!.n,0);}finally{db.close();}
});

test('real loopback HTTP uses the production composition and keeps records after stop/restart',async t=>{
  const f=await fixture(t);f.a.registerSource(source());f.a.receiveSourceItems('same-source',[item('real-http','Generated HTTP persisted')]);
  await f.node.app.listen({host:'127.0.0.1',port:0});
  const address=f.node.app.server.address() as {port:number},headers={authorization:'Bearer generated-a','x-mote-protocol-version':'2'};
  const response=await fetch(`http://127.0.0.1:${address.port}/api/captures`,{headers});assert.equal(response.status,200);assert.equal((await response.json() as any).items[0].ocrText,'Generated HTTP persisted');
  await f.node.app.close();
  const restarted=await buildApp({dataDir:f.dir},{verifier:f.identities.verifier});t.after(()=>restarted.app.close());await restarted.app.listen({host:'127.0.0.1',port:0});
  const port=(restarted.app.server.address() as {port:number}).port;
  const search=await fetch(`http://127.0.0.1:${port}/api/data/search?query=persisted`,{headers});assert.equal(search.status,200);assert.equal((await search.json() as any).items[0].text.includes('Generated HTTP persisted'),true);
  const other=await fetch(`http://127.0.0.1:${port}/api/captures`,{headers:{...headers,authorization:'Bearer generated-b'}});assert.deepEqual((await other.json() as any).items,[]);
});

test('private SQL checker rejects missing binding and direct connection bypasses',()=>{
  assert.deepEqual(checkPrivateDataSql(),[]);
  for(const source of ["sql.get('SELECT * FROM pd_captures')","sql.get('SELECT * FROM pd_captures WHERE $user IS NOT NULL')","this.sql.all(query)","db.prepare('SELECT * FROM pd_captures WHERE user_id=$user')","database.prepare('SELECT * FROM pd_captures')","this.db.exec('DELETE FROM pd_sources')"]){assert.ok(privateSqlViolations(source,'apps/server/src/scope/private-data-new.ts').length,source);}
  assert.deepEqual(privateSqlViolations("sql.get('SELECT * FROM pd_captures WHERE user_id=$user')",'apps/server/src/scope/private-data-new.ts'),[]);
});
