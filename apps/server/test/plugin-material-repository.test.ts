import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {formatMaterialRef,materialId,type MaterialDraft,type MaterialStore} from '../src/materials.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {SourceStore} from '../src/sources.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {centralServices,type CommitAuthority,type CommitAuthorization} from '../src/plugins/central-contracts.js';
import {createMaterialRepository,createMaterialRepositoryFactory,materialRepositoryContribution,materialRepositoryDeclaration,type MaterialRepositoryBindings} from '../src/plugins/material-repository.js';

function boundary(){
  const token=Object.freeze({fixture:'generated Material admission'}) as unknown as CommitAuthority;
  let current=true,calls=0,failAt:number|undefined;
  const authorization:CommitAuthorization={
    capture(){if(!current)throw Error('Generated grant revoked');return token;},
    assertCurrent(value){calls++;if(!current||value!==token||calls===failAt)throw Error('Generated Material commit rejected');},
  };
  return {authorization,token,failAfterAcceptedWrite(){failAt=calls+3;},get calls(){return calls;}};
}

async function install(host:PluginHost,store:Store,authorization:CommitAuthorization){
  const platform=createMaterialRepository(store,authorization);let bindings:MaterialRepositoryBindings|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:'generated.material-repository',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[materialRepositoryDeclaration],factory:createMaterialRepositoryFactory(platform,value=>{bindings=value;}),
  });
  const repositoryLease=await host.acquire(centralServices.materialRepository,bindings!.repository);
  const publicationLease=await host.acquire(centralServices.materialPublication,bindings!.publication);
  return {platform,handle,repository:repositoryLease.value,publication:publicationLease.value,async close(){await repositoryLease.release();await publicationLease.release();await handle.close('disabled');}};
}

function draft(text='Generated original text',externalId='generated-material'):MaterialDraft{
  return {id:materialId('generated-source',externalId),kind:'mote.message',schemaVersion:1,title:'Generated Material',
    origin:{sourceId:'generated-source',externalId,firstAt:'2026-11-01T00:00:00.000Z',lastAt:'2026-11-01T00:00:00.000Z'},
    members:[{id:'original',kind:'source-item',ref:'source-item:generated-source:original',revision:'v1',locator:{start:2,end:19}}],
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original'],locator:{start:2,end:19}}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}

function profile(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-repository-')),host=new PluginHost({kind:'central',id:'generated-material-host'});
  let store=new Store(directory);
  t.after(async()=>{await host.close();if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,host,get store(){return store;},reopen(){store.close();store=new Store(directory);return store;}};
}

test('publication ports preserve exact refs, revisions, original ranges and bounded paging; equivalent drafts do not revise',async t=>{
  const f=profile(t),auth=boundary(),current=await install(f.host,f.store,auth.authorization);
  const input=draft(),published=current.publication.publish(input,{},auth.token);
  assert.equal(published.changed,true);assert.equal(published.ref,formatMaterialRef(input.id,published.revision));
  assert.equal(current.repository.get(published.ref)?.revision,published.revision);
  assert.equal(current.repository.get(input.id)?.ref,published.ref);
  const first=current.repository.read(published.ref,{offset:0,length:9}),second=current.repository.read(published.ref,{offset:first.textRange.nextOffset!,length:100});
  assert.equal(first.text,'Generated');assert.equal(first.textRange.nextOffset,9);assert.equal(second.text,' original text\n');
  assert.equal(first.text+second.text,current.repository.read(published.ref).text);
  assert.deepEqual(first.spans[0]?.materialRange,{start:0,end:9});assert.deepEqual(second.spans[0]?.materialRange,{start:9,end:24});
  const members=current.repository.members(published.ref,{offset:0,limit:1});
  assert.deepEqual(members.items,input.members);assert.equal(members.nextOffset,null);assert.equal(members.total,1);
  const equivalent=current.publication.publish(input,{},auth.token);
  assert.equal(equivalent.changed,false);assert.equal(equivalent.ref,published.ref);assert.equal(equivalent.revision,published.revision);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM material_revisions WHERE material_id=?').get(input.id)!.n,1);
  assert.deepEqual(materialRepositoryContribution.provides.map(service=>service.id).sort(),[centralServices.materialRepository.id,centralServices.materialPublication.id].sort());
  await current.close();
});

test('stale CAS and a post-write transaction failure neither overwrite nor expose partial Material, and restart can publish',async t=>{
  const f=profile(t);let auth=boundary(),current=await install(f.host,f.store,auth.authorization);
  const base=draft(),first=current.publication.publish(base,{},auth.token);
  const revisedDraft={...base,blocks:[{...base.blocks[0]!,text:'Generated current text'}]};
  const revised=current.publication.publish(revisedDraft,{expectedRevision:first.revision},auth.token);
  assert.throws(()=>current.publication.publish({...base,blocks:[{...base.blocks[0]!,text:'Generated stale overwrite'}]},{expectedRevision:first.revision},auth.token),{statusCode:409});
  assert.equal(current.repository.get(base.id)?.revision,revised.revision);assert.equal(current.repository.read(revised.ref).text,'Generated current text\n');

  const failed=draft('Generated rolled-back text','failed-material'),before=f.store.db.prepare('SELECT count(*) n FROM material_block_payloads').get()!.n;
  auth.failAfterAcceptedWrite();
  assert.throws(()=>current.publication.publish(failed,{},auth.token),/Generated Material commit rejected/);
  assert.equal(current.repository.get(failed.id),undefined);assert.equal(current.repository.get(base.id)?.revision,revised.revision);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM material_block_payloads').get()!.n,before);
  for(const table of ['material_heads','material_revisions','material_blocks','material_members','material_evidence']){const column=table==='material_heads'?'id':'material_id';assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column}=?`).get(failed.id)!.n,0,table);}

  await current.close();const reopened=f.reopen();auth=boundary();current=await install(f.host,reopened,auth.authorization);
  assert.equal(current.repository.get(base.id)?.revision,revised.revision);assert.equal(current.repository.get(failed.id),undefined);
  const recovered=current.publication.publish(failed,{},auth.token);
  assert.equal(recovered.changed,true);assert.equal(current.repository.read(recovered.ref).text,'Generated rolled-back text\n');
  await current.close();
});

test('quiesce rejects new publication while reads survive, and a new activation restores reads and writes in the same process',async t=>{
  const f=profile(t),auth=boundary();let current=await install(f.host,f.store,auth.authorization);
  const published=current.publication.publish(draft(),{},auth.token);
  await current.handle.quiesce('upgrade');
  assert.equal(current.repository.get(published.ref)?.revision,published.revision);
  assert.throws(()=>current.publication.publish(draft('Generated late write','late'),{},auth.token),{statusCode:503});
  await current.close();assert.throws(()=>current.repository.get(published.ref));
  current=await install(f.host,f.store,auth.authorization);
  assert.equal(current.repository.read(published.ref).text,'Generated original text\n');
  const next=current.publication.publish(draft('Generated reactivated write','reactivated'),{},auth.token);
  assert.equal(current.repository.read(next.ref).text,'Generated reactivated write\n');
  await current.close();
});

test('failed prepare leaves the borrowed SQLite usable and permits a clean activation',async t=>{
  const f=profile(t),auth=boundary(),exec=f.store.db.exec.bind(f.store.db);let fail=true;
  t.mock.method(f.store.db,'exec',(sql:string,...args:unknown[])=>{
    if(fail&&sql.includes('CREATE TABLE IF NOT EXISTS material_searchable'))throw Error('Generated Material prepare failure');
    return exec(sql,...args as []);
  });
  await assert.rejects(install(f.host,f.store,auth.authorization),/Generated Material prepare failure/);
  assert.equal(f.store.db.isOpen,true);assert.equal(f.store.stats().captures,0);fail=false;
  const current=await install(f.host,f.store,auth.authorization),published=current.publication.publish(draft(),{},auth.token);
  assert.equal(current.repository.get(published.ref)?.revision,published.revision);await current.close();
});

test('a real SourceRecipe output published through the leased repository is readable by EvidenceReader',async t=>{
  const f=profile(t),auth=boundary(),current=await install(f.host,f.store,auth.authorization),materials=current.repository as MaterialStore;
  const memoryWork=new MaterialMemoryWork(f.store,materials),engine=new ExecutionEngine(f.store);
  const runtime=new SourcePipelineRuntime(f.store,materials,[codingSourcePlugin],undefined,engine,memoryWork);
  runtime.quiesce();await runtime.ready;runtime.start();
  t.after(async()=>{await runtime.close();await current.close();await engine.close();});
  const sources=new SourceStore(f.store,runtime);sources.register({id:'generated-coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
  await sources.upsert('generated-coding',{externalId:'event-one',revision:'1',observedAt:'2026-11-03T01:00:00Z',kind:'message',layer:'snapshot',text:'Generated MAT01 recipe body',
    document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:'event-one',role:'user',attribution:'human',part:0,parts:1}}});
  await runtime.tick();
  const published=materials.list().items[0];assert.ok(published);assert.equal(published.origin.sourceId,'generated-coding');
  const reader=new EvidenceReader(f.store,sources,undefined,undefined,undefined,materials,runtime);t.after(()=>reader.dispose());
  const page=reader.materialRead({ref:published.ref,offset:0,length:12000});
  assert.equal(page.material.ref,published.ref);assert.equal(page.material.revision,published.revision);assert.match(page.text,/Generated MAT01 recipe body/);
  assert.ok(page.originalRefs.length>0);assert.throws(()=>reader.materialRead({ref:materialId('generated-coding','missing')}),{statusCode:404});
});
