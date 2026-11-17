import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {serviceContract,type ServiceBinding,type ServiceContract} from '@mote/plugin-api/contracts';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {createEvidenceReaderFacade,createEvidenceReaderForAssembly} from '../src/evidence-reader.js';
import {createContextTrees,createContextTreesReadCapability} from '../src/context-trees.js';
import {FeatureScope} from '../src/features/index.js';
import {createDomainActivations} from '../src/domain-activation.js';
import {centralServices,type CommitAuthority,type CommitAuthorization} from '../src/plugins/central-contracts.js';
import {materialRepositoryInputsContribution,materialRepositoryInputsDeclaration,type MaterialRepositoryInputs,type MaterialRepository} from '../src/plugins/material-repository.js';
import {materialRetrievalIndexInputsContribution,materialRetrievalIndexInputsDeclaration,type MaterialRetrievalIndexInputs,type MaterialRetrievalIndex} from '../src/plugins/material-retrieval-index.js';
import {materialContextInputsContribution,materialContextInputsDeclaration,type MaterialContextInputs,type MaterialContext} from '../src/plugins/material-context.js';
import {evidenceContextReaderInputsContribution,evidenceContextReaderInputsDeclaration,type EvidenceContextReaderInputs,type EvidenceContextReader} from '../src/plugins/evidence-context-reader.js';
import {domainPlugins} from '../src/assembly/materials.js';

const lifecycle={prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
const token=Object.freeze({fixture:'material-domain-installation'}) as unknown as CommitAuthority;
const authorization:CommitAuthorization={capture:()=>token,assertCurrent(){}};

function draft(captureId:string):MaterialDraft{
  return {id:materialId('generated-material-domain','item'),kind:'mote.note',schemaVersion:1,title:'Generated selected Material',
    origin:{sourceId:'generated-material-domain',externalId:'item',firstAt:'2026-11-17T00:00:00.000Z',lastAt:'2026-11-17T00:00:00.000Z'},
    members:[{id:'original',kind:'capture',ref:'capture:'+captureId}],
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated selected Material body',memberIds:['original']}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}

async function publishInput<T>(host:PluginHost,register:(binding:ServiceBinding)=>void,contribution:{readonly id:string},declaration:{readonly id:string;readonly apiVersion:string},contract:ServiceContract<T>,value:T){
  let binding:ServiceBinding|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:contribution.id,installationId:`build:${contribution.id}@1.0.0`,instanceId:`${contribution.id}-input`,activationId:randomUUID()},
    contributions:[declaration],restartRequired:true,
    factory(context){binding=context.provide(contribution.id,contract,value);register(binding);return lifecycle;},
  });
  if(!binding)throw Error('Input provider did not publish its binding');
  return {handle,binding};
}

function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-domain-installation-')),host=new PluginHost({kind:'central',id:randomUUID()}),app=Fastify();
  let store=new Store(directory),engine=new ExecutionEngine(store),sources=new SourceStore(store);
  t.after(async()=>{await app.close();await host.close();await engine.close();if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,host,app,get store(){return store;},get engine(){return engine;},get sources(){return sources;}};
}

test('selected Material owners install through one PluginHost, serve the real Material and fence late reads on close',{timeout:120000},async t=>{
  const f=fixture(t),registry=createDomainActivations(f.host,domainPlugins.filter(plugin=>plugin.activation),['mote.materials','mote.context']);
  assert.ok(registry.selectedDomain('material-repository'));
  assert.ok(registry.selectedDomain('material-retrieval-index'));
  assert.ok(registry.selectedDomain('material-context'));
  assert.ok(registry.selectedDomain('evidence-context-reader'));

  let repository:MaterialRepository|undefined,repositoryBindings:ReturnType<NonNullable<MaterialRepositoryInputs['onStarted']>>|undefined;
  const repositoryInput=await publishInput(f.host,binding=>registry.register(binding),materialRepositoryInputsContribution,materialRepositoryInputsDeclaration,
    serviceContract<MaterialRepositoryInputs>('mote.central.material-repository-inputs','1'),{
      store:f.store,authorization,onStarted(platform,bindings){repository=platform;repositoryBindings=bindings;},
    });
  t.after(()=>repositoryInput.handle.close('shutdown'));
  await registry.installDomain('material-repository');
  assert.ok(repository&&repositoryBindings);
  const materials=repository!.storeForAssembly;

  const embedding={model:'',baseUrl:'',apiKey:''};
  let retrieval:MaterialRetrievalIndex|undefined;
  const retrievalInput=await publishInput(f.host,binding=>registry.register(binding),materialRetrievalIndexInputsContribution,materialRetrievalIndexInputsDeclaration,
    serviceContract<MaterialRetrievalIndexInputs>('mote.central.material-retrieval-index-inputs','1'),{
      store:f.store,embedding,executor:f.engine,materials,onStarted(platform){retrieval=platform;},
    });
  t.after(()=>retrievalInput.handle.close('shutdown'));
  const timers={created:0,cleared:0,active:new Set<ReturnType<typeof setInterval>>()},setInterval=globalThis.setInterval,clearInterval=globalThis.clearInterval;
  globalThis.setInterval=((...args:Parameters<typeof setInterval>)=>{timers.created++;const timer=setInterval(...args);timers.active.add(timer);return timer;}) as typeof setInterval;
  globalThis.clearInterval=((timer:ReturnType<typeof setInterval>)=>{timers.cleared++;timers.active.delete(timer);clearInterval(timer);}) as typeof clearInterval;
  t.after(()=>{globalThis.setInterval=setInterval;globalThis.clearInterval=clearInterval;});
  await registry.installDomain('material-retrieval-index');
  assert.ok(retrieval);
  assert.ok(timers.created>0&&timers.active.size>0,'the selected retrieval owner starts its real timer');

  let reader:EvidenceContextReader|undefined;
  const rawReader=createEvidenceReaderForAssembly({store:f.store,sources:f.sources,materials,indexer:retrieval!.retrievalIndex});
  const readerInput=await publishInput(f.host,binding=>registry.register(binding),evidenceContextReaderInputsContribution,evidenceContextReaderInputsDeclaration,
    serviceContract<EvidenceContextReaderInputs>('mote.central.evidence-context-reader-inputs','1'),{
      reader:createEvidenceReaderFacade(rawReader),contextTrees:createContextTreesReadCapability(createContextTrees()),mountRoutes:()=>{},onStarted(platform){reader=platform;},
    });
  t.after(()=>readerInput.handle.close('shutdown'));
  await registry.installDomain('evidence-context-reader');
  assert.ok(reader);

  const organizer=new MaterialOrganizerRuntime(f.store,materials,[],f.engine);
  t.after(()=>organizer.close());
  let context:MaterialContext|undefined;
  const contextInput=await publishInput(f.host,binding=>registry.register(binding),materialContextInputsContribution,materialContextInputsDeclaration,
    serviceContract<MaterialContextInputs>('mote.central.material-context-inputs','1'),{
      materials,organizer,reader:rawReader,onStarted(platform){context=platform;},
    });
  t.after(()=>contextInput.handle.close('shutdown'));
  await registry.installDomain('material-context');
  assert.ok(context);

  const domains=await registry.activate();
  assert.deepEqual(domains.routes.map(route=>route.id),['mote.materials','mote.context']);
  const scope=new FeatureScope();t.after(()=>scope.close());
  for(const route of domains.routes)route.mount(f.app,scope);

  const captureId=randomUUID();
  await f.store.ingest({id:captureId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:'2026-11-17T00:00:00.000Z',durationMs:0,ocrText:'Generated original'});
  const published=repository!.publication.publish(draft(captureId),{},token);
  const list=await f.app.inject({url:'/api/materials'});assert.equal(list.statusCode,200,list.body);
  assert.ok(list.json().items.some((item:{ref:string})=>item.ref===published.ref));
  const page=reader!.ports.materialRead.materialRead({ref:published.ref});
  assert.match(page.text,/Generated selected Material body/);
  assert.ok(await reader!.ports.contextTreesRead.catalog());
  const savedRead=reader!.ports.materialRead.materialRead;
  const materialRead=await registry.acquire('evidence-context-reader',centralServices.materialRead);
  assert.equal(materialRead.value.materialRead({ref:published.ref}).material.revision,published.revision);

  await domains.close();
  assert.equal((await f.app.inject({url:'/api/materials'})).statusCode,503);
  assert.throws(()=>savedRead({ref:published.ref}),{statusCode:503});
  assert.throws(()=>materialRead.value.materialRead({ref:published.ref}),{code:'dependency_unavailable'});
  assert.equal(timers.active.size,0,'the selected retrieval timer is cleared on close');
  await materialRead.release();

  const reopened=new MaterialStore(f.store);
  assert.equal(reopened.read(published.ref).text,'Generated selected Material body\n');
  reopened.store.close();
});

test('omitted Material or Context selection creates no input, owner, table, timer or handler; the shared Store stays writable',async t=>{
  for(const selection of ['feature-omitted','plugin-omitted'] as const)await t.test(selection,async t=>{
    const f=fixture(t),plugins=domainPlugins.filter(plugin=>plugin.activation),registry=selection==='plugin-omitted'
      ?createDomainActivations(f.host,[],['mote.materials','mote.context'])
      :createDomainActivations(f.host,plugins,[]);
    for(const id of ['material-repository','material-retrieval-index','material-context','evidence-context-reader'])assert.equal(registry.selectedDomain(id),undefined);
    await assert.rejects(registry.installDomain('material-context'),{code:'dependency_unavailable'});
    const domains=await registry.activate();
    assert.deepEqual(domains.routes,[]);
    assert.equal(f.host.snapshot().contributions.length,0);
    assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='material_heads'").get(),undefined);
    const id=randomUUID();
    await f.store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:'2026-11-17T00:00:00.000Z',durationMs:0,ocrText:'Generated shared original remains writable'});
    assert.equal(f.store.evidence([id]).length,1);
    await domains.close();
  });
});
