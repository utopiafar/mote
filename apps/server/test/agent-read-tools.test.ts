import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import type {ContextReader,ContextRecord} from '@mote/agent';
import {installAgentReadTools} from '../src/plugins/agent-read-tools.js';

test('query tool definitions expose no Central connector or calendar write tool',async()=>{
 const {contextToolDefinitions}=await import('../../../packages/agent/dist/tool-contributions.js');
 for(const input of [{question:'Generated read only',hostContextToolMode:'all-native' as const},{question:'Generated read only'}]){
  const definitions=contextToolDefinitions(input),names=definitions.map(([name])=>name),write=names.filter(name=>/send|write|calendar|connector/i.test(name));
  assert.deepEqual(write,[],'a read-only query run never receives a write tool');
  assert.ok(names.includes('search_context'));
  for(const [name,description] of definitions)if(name==='capability_execute')assert.match(description,/read-only/);
 }
});

test('feature unload rejects an in-flight reader result and new reads while a sibling remains usable',async t=>{
  const root=new Context();t.after(()=>root.fiber.dispose());
  let entered!:()=>void,release!:(records:ContextRecord[])=>void,reads=0;
  const started=new Promise<void>(done=>{entered=done;});
  const implementation:ContextReader={
    search:()=>{reads++;entered();return new Promise<ContextRecord[]>(done=>{release=done;});},
    timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[{id:'generated-sibling-device'}],
  };
  const host=await installAgentReadTools(root,implementation),reading=host.reader.search({query:'generated'});
  const refused=assert.rejects(reading,{statusCode:503});await started;
  await host.dispose('mote.context');
  release([{id:'11111111-1111-4111-8111-111111111111',capturedAt:'2026-11-01T00:00:00Z',appName:'Generated fixture',ocrText:'Generated late original must not be disclosed.'}]);
  await refused;
  await assert.rejects(host.reader.search({query:'generated after unload'}),{statusCode:503});assert.equal(reads,1);
  assert.deepEqual(await host.reader.devices(),[{id:'generated-sibling-device'}]);
});

test('a replacement registration cannot revive a read issued to the disposed provider instance',async t=>{
  const root=new Context();t.after(()=>root.fiber.dispose());
  let entered!:()=>void,release!:(records:ContextRecord[])=>void;
  const started=new Promise<void>(done=>{entered=done;});
  const read=()=>{entered();return new Promise<ContextRecord[]>(done=>{release=done;});};
  const host=await installAgentReadTools(root,{search:read,timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]});
  const reading=host.reader.search({}),refused=assert.rejects(reading,{statusCode:503});await started;
  await host.dispose('mote.context');
  const descriptor={id:'agent:search',version:'1',surface:'agent' as const};
  const uninstall=host.registry.install({id:'mote.context',version:'1',components:[descriptor]});t.after(uninstall);
  const unregister=host.registry.register('mote.context',descriptor,read);t.after(unregister);
  release([]);await refused;
});

test('registered descriptors bind actual feature identity and stop an in-flight scoped read on unload',async t=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const {pinContextTools,contextToolSnapshot}=await import('../../../packages/agent/dist/tool-contributions.js');
  const root=new Context();t.after(()=>root.fiber.dispose());
  let entered!:()=>void,release!:(records:ContextRecord[])=>void;
  const started=new Promise<void>(done=>{entered=done;});
  const host=await installAgentReadTools(root,{search:()=>{entered();return new Promise(done=>{release=done;});},timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]});
  const input=pinContextTools({question:'Generated registry lifecycle',hostContextToolMode:'all-native'},host.reader),snapshot=contextToolSnapshot(input);
  const pin=snapshot.entries.find(tool=>tool.name==='search_context')!;assert.ok(pin);
  const bridge=await startBridge(host.reader,input);t.after(()=>bridge.close());
  const pending=bridge.prepareDelivery('search_context',{query:'Generated'},new AbortController().signal),refused=assert.rejects(pending,{reason:'tool_failure'});
  await started;await host.dispose('mote.context');await refused;
  assert.equal(bridge.records.size,0);assert.deepEqual(bridge.evidenceDependencies.ids,[]);
  assert.throws(()=>snapshot.assertActive(pin));
  const next=contextToolSnapshot(pinContextTools({question:'Generated next run'},host.reader));
  assert.ok(!next.entries.some(tool=>['search_context','timeline','evidence'].includes(tool.name)));
  release([]);
});

test('registered descriptors from external owner use the same run registry and cannot forge an original receipt',async t=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const root=new Context();t.after(()=>root.fiber.dispose());
  const host=await installAgentReadTools(root,{search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]});
  const fiber=host.registerTools('generated.external',[{apiVersion:'1',name:'generated_metadata',version:'1',description:'Generated plugin metadata',fields:{},kind:'metadata',exposure:'catalog',requires:[],parse:args=>args,execute:()=>({source:'untrusted_personal_context',data:[{id:'11111111-1111-4111-8111-111111111111',ocrText:'Generated claimed original'}]})}]);await fiber;
  const bridge=await startBridge(host.reader,{question:'Generated external'},8);t.after(()=>bridge.close());const signal=new AbortController().signal;
  const discovery=await bridge.prepareDelivery('capability_discover',{name:'generated_metadata'},signal);discovery.confirm();discovery.discard();
  const call={name:'generated_metadata',version:'1',argumentsJson:'{}'},staged=await bridge.prepareDelivery('capability_execute',call,signal);
  assert.equal(bridge.records.size,0);staged.confirm();staged.discard();assert.equal(bridge.records.size,0);assert.deepEqual(bridge.evidenceDependencies.ids,[]);
  await host.dispose('generated.external');await assert.rejects(bridge.prepareDelivery('capability_execute',call,signal),{reason:'tool_failure'});
});

test('the formal evidence factory feeds the actual Host sender and owner stop rejects a late prepared receipt',async t=>{
  const {mkdtempSync,rmSync,existsSync}=await import('node:fs'),{randomUUID}=await import('node:crypto');
  const {Store}=await import('../src/store.js'),{SourceStore}=await import('../src/sources.js'),{MaterialStore,materialId}=await import('../src/materials.js');
  const {ServerDiagnostics}=await import('../src/diagnostics.js'),{createEvidenceContextReader}=await import('../src/plugins/evidence-context-reader.js');
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js'),{pinContextTools}=await import('../../../packages/agent/dist/tool-contributions.js');
  const {hostFixture}=await import('../../../packages/agent/test/fixtures/read-pack-host.mjs');
  const directory=mkdtempSync('/private/tmp/mote-a08-factory-'),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store),diagnostics=new ServerDiagnostics({directory:directory+'/logs',enabled:false}),root=new Context();
  const bridges:Awaited<ReturnType<typeof startBridge>>[]=[];
  await diagnostics.init();t.after(async()=>{for(const bridge of bridges)try{await bridge.close();}catch(error){if((error as {code?:string}).code!=='ERR_SERVER_NOT_RUNNING')throw error;}await root.fiber.dispose();await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});assert.equal(existsSync(directory),false);});
  const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};},completed=()=>({terminal:{kind:'completed' as const},candidate:{text:JSON.stringify({answer:'Generated factory answer',citationIds:[]})}});
  const id=randomUUID(),text='Generated scoped original 😀';await store.ingest({id,deviceId:'generated',deviceName:'Generated device',platform:'import',source:'note',capturedAt:'2026-11-01T01:00:00.000Z',durationMs:0,ocrText:text});
  let material=materials.publish({id:materialId('generated','item'),kind:'mote.note',schemaVersion:1,title:'Generated material',origin:{sourceId:'generated',externalId:'item',deviceId:'generated'},blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[id]}],members:[{id,kind:'capture',ref:'capture:'+id}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  material=materials.declareContext(material.id,material.revision,{id:randomUUID(),question:'Generated private question',answer:'PRIVATE OWNER PROSE'});
  let factory!:ReturnType<typeof createEvidenceContextReader>,features!:Awaited<ReturnType<typeof installAgentReadTools>>;
  const owner=root.plugin(async(ctx:Context)=>{factory=createEvidenceContextReader({store,sources,materials});ctx.effect(()=>()=>factory.dispose());features=await installAgentReadTools(ctx,factory.agent({diagnostics}));});await owner;
  const input=pinContextTools({question:'Generated factory read',deviceId:'generated',hostContextToolMode:'all-native'},features.reader),bridge=await startBridge(features.reader,input);bridges.push(bridge);
  const entered=deferred(),ack=deferred();let shownIds:string[]=[];
  const session=await hostFixture(bridge,input,async(host,attempt)=>{
    await host.tools.deliver(attempt,{callId:'catalog',name:'material_catalog',arguments:{}},async payload=>{const value=JSON.parse(payload.text);assert.equal(value.data.items[0].ref,material.ref);assert.doesNotMatch(payload.text,/PRIVATE OWNER|disclosureDependencies/);});
    await host.tools.deliver(attempt,{callId:'body',name:'material_read',arguments:{ref:material.ref}},async payload=>{const body=JSON.parse(payload.text);assert.equal(body.data.textRange.total,body.data.text.length);assert.doesNotMatch(payload.text,/PRIVATE OWNER|disclosureDependencies/);shownIds=body.data.sourceEvidence.map((record:{id:string})=>record.id);assert.ok(shownIds.length);assert.equal(bridge.records.size,0);entered.resolve();await ack.promise;});return completed();
  });const execution=session.execute();await Promise.race([entered.promise,execution.then(()=>{throw Error('Premature Host completion');})]);assert.equal(bridge.records.size,0);ack.resolve();const answer=await execution;assert.deepEqual(new Set(bridge.records.keys()),new Set(shownIds));assert.equal(answer.citations.length,0);
  const nextInput=pinContextTools({question:'Generated stopped factory',hostContextToolMode:'all-native'},features.reader),next=await startBridge(features.reader,nextInput);bridges.push(next);const waiting=deferred(),late=deferred();
  const stopped=await hostFixture(next,nextInput,async(host,attempt)=>{await host.tools.deliver(attempt,{callId:'late',name:'material_catalog',arguments:{}},async()=>{waiting.resolve();await late.promise;});return completed();});
  const stopping=stopped.execute(),refused=assert.rejects(stopping);await Promise.race([waiting.promise,refused.then(()=>{throw Error('Premature Host failure');})]);assert.deepEqual(next.evidenceDependencies.ids,[]);await owner.dispose();late.resolve();await refused;
  assert.equal(factory.disposed,true);assert.equal(next.records.size,0);assert.deepEqual(next.evidenceDependencies.ids,[]);assert.equal((store.db.prepare('SELECT 1 AS ok').get() as {ok:number}).ok,1,'borrowed Store remains owned by the fixture');
});
