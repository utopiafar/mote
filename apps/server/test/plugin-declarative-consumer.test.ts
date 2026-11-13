import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {strToU8, zipSync} from 'fflate';
import type {PluginManifest, PluginReleaseTransport} from '../src/plugin-release.js';
import {Store, sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {PluginCenter} from '../src/plugin-center.js';
import {pluginInstanceDescriptor, pluginInstanceSpec, pluginInstanceInvoker} from '../../web/src/features/runtime.js';
import {DeclarativeViewSession} from '../../web/src/plugin-host/declarative-view.js';
import {renderToStaticMarkup} from 'react-dom/server';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import type {QueryScope,WorkspaceRequest,WorkspaceView} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {materialId} from '../src/materials.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {WorkspaceSurface,workspacePath,workspaceSession} from '../../web/src/plugins/assistant-workbench.js';

const worker = `export async function createMemoryProvider(){return {async health(){return {providerId:'generated',version:'1',ready:true,verified:{},problems:[]};},async read(){return null;},async search(){return [];},async export(){return [];},async put(){return {state:'applied'};},async remove(){return {state:'removed'};},async close(){}};}`;

async function waitFor(check: () => boolean, what: string) {
  const until = Date.now() + 5000;
  while (!check()) {assert.ok(Date.now() < until, what); await delay(5);}
}

// T3: a real PluginCenter pipeline emits the actual PluginCenterView, which
// the web declarative adapter and invoker consume — not a hand-shaped view
// model. Only the GitHub release transport and the worker probe are
// generated stubs; the view, revision and allowedActions are producer code.
test('a real producer-emitted instance drives the declarative adapter and precise commands', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-declarative-consumer-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const archive = zipSync({'provider.mjs': strToU8(worker)});
  const repository = 'generated-fixture/mote-adapter', tag = 'v1.0.0', commit = 'a'.repeat(40);
  const manifest: PluginManifest = {schemaVersion: 1, id: 'generated.t3', name: 'T3 adapter', version: '1.0.0', runtime: 'worker', entry: 'provider.mjs',
    archive: {asset: 'adapter.zip', sha256: sha256(archive)}, capabilities: ['repository'], configuration: [{id: 'label', label: 'Label', type: 'text', required: true}], dependencies: [], access: ['Generated only']};
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const transport: PluginReleaseTransport = async url => {
    if (url.endsWith(`/releases/tags/${tag}`)) return {bytes: strToU8(JSON.stringify({tag_name: tag, draft: false, assets: [{name: 'mote-plugin.json', browser_download_url: base + 'mote-plugin.json'}, {name: 'adapter.zip', browser_download_url: base + 'adapter.zip'}]}))};
    if (url.endsWith(`/commits/${tag}`)) return {bytes: strToU8(JSON.stringify({sha: commit}))};
    if (url === base + 'mote-plugin.json') return {bytes: strToU8(JSON.stringify(manifest))};
    if (url === base + 'adapter.zip') return {bytes: archive};
    throw new Error('fixture transport rejects: ' + url);
  };
  const store = new Store(directory), executor = new ExecutionEngine(store, () => Date.now());
  const plugins = new PluginCenter(store, executor, new GitHubPluginReleases(join(directory, 'packages'), transport));
  plugins.probe = async () => ({capabilities: [{id: 'repository', state: 'verified'}], issues: []});
  t.after(async () => {await executor.close(); await plugins.close(); store.close();});

  const preview = await plugins.resolve({repository, tag});
  plugins.install({previewId: preview.id, operationId: randomUUID(), expectedRevision: plugins.revision()});
  await waitFor(() => plugins.view().packages[0]?.state === 'installed', 'generated release installs');
  const instance = plugins.configure(undefined, {packageId: plugins.view().packages[0]!.id, name: 'T3 instance', scope: 'default', configuration: {label: 'one'}, operationId: randomUUID(), expectedRevision: plugins.revision()});
  plugins.action(instance.id, 'check', {operationId: randomUUID(), expectedRevision: plugins.instanceView(instance.id).revision});
  await waitFor(() => plugins.instanceView(instance.id).observed === 'ready', 'generated worker check settles');
  plugins.action(instance.id, 'enable', {operationId: randomUUID(), expectedRevision: plugins.instanceView(instance.id).revision});
  await waitFor(() => plugins.instanceView(instance.id).desired === true, 'generated instance desired flips');

  // The real emitted view — identity, revision and allowedActions produced
  // by the producer itself.
  const emitted = plugins.instanceView(instance.id);
  assert.ok(emitted.allowedActions.length > 0, 'real view carries allowedActions');
  assert.ok(emitted.revision > 0);

  const spec = pluginInstanceSpec(emitted);
  const declared = new Set(pluginInstanceDescriptor(emitted).commands?.map(c => c.id));
  for (const component of spec.components) if (component.type === 'action') assert.ok(emitted.allowedActions.includes(component.command), 'every rendered action is DOMAIN-allowed');

  const calls: [string, number][] = [];
  const session = new DeclarativeViewSession(pluginInstanceDescriptor(emitted), spec, pluginInstanceInvoker(emitted, (path, revision) => {calls.push([path, revision]);}));
  session.lifetime.show();
  if (declared.has('enable')) {
    await session.command('enable');
    assert.deepEqual(calls, [[`/api/plugin-instances/${encodeURIComponent(emitted.id)}/enable`, emitted.revision]], 'command carries the emitted identity + revision');
  } else if (declared.has('disable')) {
    await session.command('disable');
    assert.deepEqual(calls, [[`/api/plugin-instances/${encodeURIComponent(emitted.id)}/disable`, emitted.revision]]);
  } else assert.fail('emitted instance must expose at least one lifecycle command');
  assert.equal(await session.command('uninstall').then(r => r.ok), false, 'undeclared command never fires');
});

const workbenchHeaders={authorization:'Bearer generated-workbench-owner'};
const observedAt='2026-10-01T10:00:00Z';
async function workbenchFixture(t:import('node:test').TestContext){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-workbench-'));
  const config:Config={dataDir,token:'generated-workbench-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}});
  await node.app.ready();t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  node.sources.register({id:'generated-workbench-a',name:'Generated workbench A',kind:'custom',deviceId:'generated-a',platform:'import'});
  node.sources.register({id:'generated-workbench-b',name:'Generated workbench B',kind:'custom',deviceId:'generated-b',platform:'import'});
  node.sources.register({id:'generated-workbench-files',name:'Generated workbench files',kind:'local-files',deviceId:'generated-a',platform:'import',retention:'archive'});
  const scope:QueryScope={kind:'selection',sourceIds:['generated-workbench-a','generated-workbench-files']};
  const original=async(sourceId:string,body:string)=>{
    const externalId=randomUUID(),saved=await node.sources.upsert(sourceId,{externalId,revision:'1',observedAt,kind:'message',layer:'original',title:body,text:body,document:{contentRole:'authored'}});
    await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);
    const material=node.materials.get(materialId(sourceId,externalId))!;
    assert.ok(material,'the official source-item organizer publishes the generated original');
    const id=node.materials.evidenceIds(material.ref,material.artifacts!.find(item=>item.key==='source-body')!.blockIds)[0]!;
    return {id,rootId:saved.id,externalId,body:node.memories.readEvidence([id])[0].ocrText};
  };
  const a=await original('generated-workbench-a','Generated studio plan'),b=await original('generated-workbench-b','GENERATED_PRIVATE_PLAN');
  const memory=(ids:string[],title:string)=>{
    const raw={answer:JSON.stringify({memories:[{title,statement:title+' '+ids.map(id=>'['+id+']').join(' '),uncertainty:'Generated evidence limits',evidenceIds:ids}]}),
      citations:ids.map(id=>({id,capturedAt:observedAt,appName:'Generated',excerpt:node.memories.readEvidence([id])[0].ocrText})),trace:[],runId:randomUUID()};
    const draft=node.memories.extract(fixtureMemoryResult(node.memories,raw),'generated').items[0]!;
    return node.memories.publish(draft.id,draft.version);
  };
  const person=memory([a.id],'Generated Alex'),privatePerson=memory([b.id],'GENERATED_PRIVATE_PERSON');
  memory([a.id,b.id],'GENERATED_MIXED_PRIVATE_PERSON');
  const authority={currentEvidence:(ids:readonly string[])=>node.featureServices.evidenceReader.evidence(ids.map(id=>'capture:'+id)).map(record=>({id:record.id,title:record.windowTitle,sourceId:record.provenance?.sourceId,deviceId:record.deviceId,at:record.capturedAt})),currentTask:()=>undefined};
  const matters=node.featureServices.assistantMatters;
  const reader=node.featureServices.evidenceReader;
  assert.deepEqual(reader.memories.readEvidence([a.id]),node.memories.readEvidence([a.id]),'fixture evidence must have the same canonical identity in the consumer');
  assert.equal(reader.contextDependenciesAllowed([a.id]),true,'fixture source permits the current original');
  assert.equal(memoryEvidenceFingerprint(reader.memories.readEvidence([a.id])[0]),person.evidence[0].contentHash,'fixture Memory pins the exact current original');
  reader.assertMemoryReadable([person]);
  const matter=matters.command({type:'create',requestId:randomUUID(),goal:'Generated studio goal',scope,evidenceIds:[a.id]},authority);
  matters.command({type:'create',requestId:randomUUID(),goal:'GENERATED_PRIVATE_GOAL',scope:{kind:'all'},evidenceIds:[b.id]},authority);
  const commitment=node.featureServices.assistantCommitments.publish({commitmentId:randomUUID(),eventId:randomUUID(),kind:'commitment',occurredAt:null,
    summary:'Generated will share the plan',changes:{title:'Generated plan commitment',deadline:{text:'when ready',at:null},personMemoryId:person.id,matterId:matter.id},
    evidence:[{id:a.id,offset:0,quote:a.body}],evidenceDependencies:{version:1,complete:true,ids:[a.id]}},undefined,scope,()=>{});
  const bytes=Buffer.from('Generated reading material');
  const manifest={sourceId:'generated-workbench-files',item:{externalId:'generated-reading.txt',revision:'1',observedAt,title:'Generated reading.txt',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)};
  const begun=await node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers:workbenchHeaders,payload:manifest});assert.equal(begun.statusCode,200,begun.body);
  const uploadId=begun.json().uploadId;
  const part=await node.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${uploadId}/parts/0`,headers:{...workbenchHeaders,'content-type':'application/octet-stream'},payload:bytes});assert.equal(part.statusCode,200,part.body);
  const committed=await node.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${uploadId}/commit`,headers:workbenchHeaders});assert.equal(committed.statusCode,200,committed.body);
  const fileId=committed.json().id;
  const withdraw=async()=>{
    const response=await node.app.inject({method:'PUT',url:'/api/sources/generated-workbench-a/items',headers:workbenchHeaders,
      payload:{externalId:a.externalId,revision:'2',observedAt:'2026-10-02T10:00:00Z',kind:'message',layer:'original',text:'',deleted:true}});
    assert.equal(response.statusCode,200,response.body);
  };
  const read=async(request:WorkspaceRequest)=>{
    const response=await node.app.inject({url:workspacePath(request),headers:workbenchHeaders});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'no-store');
    return response.json() as WorkspaceView;
  };
  const calls:{path:string;status:number}[]=[];
  const api={request:async<T>(path:string,init:RequestInit={}):Promise<T>=>{
    const response=await node.app.inject({method:(init.method??'GET') as 'GET'|'POST',url:path,headers:workbenchHeaders,...(init.body?{payload:JSON.parse(String(init.body))}:{})});
    calls.push({path,status:response.statusCode});if(response.statusCode!==200)throw Error(response.body);return response.json();
  }};
  return {node,scope,a,b,person,privatePerson,matter,commitment,fileId,memory,original,withdraw,read,api,calls};
}

test('all four real HTTP workbench outputs drive the actual TS decoder and generic container',async t=>{
  const f=await workbenchFixture(t);
  for(const template of ['project','person','travel','reading'] as const){
    const view=await f.read({template,scope:f.scope,...(template==='person'?{personMemoryId:f.person.id}:{matterId:f.matter.id})});
    const {session}=workspaceSession(view,f.api);
    assert.equal(session.descriptor.kind,'declarative-view');
    const markup=renderToStaticMarkup(createElement(WorkspaceSurface,{value:view,api:f.api}));
    assert.match(markup,/Generated (studio goal|Alex)/);assert.match(markup,/Generated plan commitment|Generated Alex/);
    assert.doesNotMatch(JSON.stringify(view),/GENERATED_PRIVATE|GENERATED_MIXED_PRIVATE/);
    assert.deepEqual(view.commands.map(command=>command.id),view.descriptor.commands?.map(command=>command.id));
    assert.ok(view.spec.components.some(component=>component.type==='form'));
    assert.ok(view.spec.components.some(component=>component.type==='action'));
    assert.equal((view.data.commitments as any[])[0].dueState,'unknown','a vague deadline stays unknown in every template');
    if(template==='person'){
      const evidence=(view.data.evidence as any[])[0];assert.ok(evidence);
      assert.equal(Date.parse(evidence.observedAt),Date.parse(observedAt));assert.equal(evidence.occurredAt,null,'discovery does not invent an occurrence time');
    }
    if(template==='person')assert.equal(f.node.featureServices.assistantMatters.page().items.length,2,'reading a person does not create a matter');
  }
  const reading=await f.read({template:'reading',scope:f.scope});
  const file=(reading.data.files as any[]).find(item=>item.id===f.fileId);assert.ok(file,'the real uploaded file enters the projection');
  assert.equal(file.original,true);assert.ok(file.coverage.extraction);assert.ok(file.coverage.semantic);assert.ok(file.coverage.embedding);
  const feature=await f.node.app.inject({url:'/api/features',headers:workbenchHeaders});
  assert.ok(feature.json().capabilities.some((entry:any)=>entry.id==='http:GET:/api/assistant/workbench'&&entry.state==='active'));
});

test('the emitted command references edit, pause and archive the real matter and reject stale versions',async t=>{
  const f=await workbenchFixture(t),view=await f.read({template:'project',scope:f.scope,matterId:f.matter.id});
  const {session}=workspaceSession(view,f.api);session.lifetime.show();
  assert.deepEqual(await session.command('execute-script'),{ok:false,reason:'undeclared'});
  assert.equal(f.calls.length,0);
  assert.equal((await session.command('matter.edit',{goal:'Generated corrected studio goal'})).ok,true);
  assert.equal(f.node.featureServices.assistantMatters.get(f.matter.id).goal,'Generated corrected studio goal');
  assert.deepEqual(await session.command('matter.pause'),{ok:false,reason:'failed'});assert.equal(f.calls.at(-1)!.status,409);
  const next=workspaceSession(await f.read(view.request),f.api);next.session.lifetime.show();
  assert.equal((await next.session.command('matter.pause')).ok,true);
  const paused=await f.read(view.request);assert.ok(paused.commands.some(command=>command.id==='matter.resume'));
  const archive=workspaceSession(paused,f.api);archive.session.lifetime.show();
  assert.equal((await archive.session.command('matter.archive')).ok,true);
  assert.equal(f.node.featureServices.assistantMatters.get(f.matter.id).state,'archived');
  assert.equal(f.node.memories.get(f.person.id).status,'published','archiving a workbench matter does not delete a person Memory');
  assert.deepEqual((await f.read(view.request)).commands.map(command=>command.id),['refresh']);
});

test('workbench scope hides mixed dependencies, empty selections, withdrawn titles and stale commands',async t=>{
  const f=await workbenchFixture(t),before=await f.read({template:'person',scope:f.scope,personMemoryId:f.person.id});
  for(const scope of [{kind:'selection' as const,sourceIds:[]},{kind:'selection' as const,evidenceIds:[]},{kind:'selection' as const,sourceIds:['generated-workbench-a'],evidenceIds:[f.b.id]}]){
    const empty=await f.read({template:'reading',scope});
    assert.deepEqual(empty.data.files,[]);assert.deepEqual(empty.data.memories,[]);assert.deepEqual(empty.data.matters,[]);assert.deepEqual(empty.data.commitments,[]);
    assert.doesNotMatch(JSON.stringify(empty),/Generated studio|Generated Alex|GENERATED_PRIVATE|GENERATED_MIXED/);
  }
  f.node.sources.update('generated-workbench-a',{enabled:false});
  assert.equal((await f.read(before.request)).data.title,'Generated Alex','stopping synchronization retains legal Memory history');
  f.node.sources.update('generated-workbench-a',{enabled:true});await f.withdraw();
  for(const request of [before.request,{template:'project' as const,scope:f.scope,matterId:f.matter.id}]){
    const after=await f.read(request);assert.doesNotMatch(JSON.stringify(after),/Generated studio|Generated Alex|Generated plan commitment|reading.txt/);
    assert.ok(after.spec.components.some(component=>component.type==='status'&&component.state==='unavailable'));
    assert.deepEqual(after.commands.map(command=>command.id),['refresh']);
  }
  const stale=await f.node.app.inject({method:'POST',url:'/api/assistant/workbench/commands',headers:workbenchHeaders,payload:{request:before.request,command:before.commands.find(command=>command.id==='memory.correct'),input:{title:'Generated stale',statement:'Generated stale change'}}});
  assert.equal(stale.statusCode,409,stale.body);assert.equal(f.node.memories.get(f.person.id).title,'Generated Alex');
});

test('partial file failures keep independent sections and Memory corrections use the real owner product writer',async t=>{
  const f=await workbenchFixture(t);
  // Generated upstream failure state. FileView itself still produces the
  // coverage; the test never hand-builds a workspace or coverage receipt.
  f.node.store.db.prepare("UPDATE file_jobs SET state='failed',error='Generated extraction failure' WHERE capture_id=?").run(f.fileId);
  const partial=await f.read({template:'reading',scope:f.scope});
  assert.ok((partial.data.memories as any[]).some(item=>item.id===f.person.id));
  assert.equal((partial.data.files as any[]).find(item=>item.id===f.fileId).extraction,'failed');
  assert.ok(partial.spec.components.some(component=>component.type==='status'&&component.state==='error'));
  const view=await f.read({template:'person',scope:{kind:'all'},personMemoryId:f.person.id});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://generated.example',pretendToBeVisual:true});
  const previous=new Map(['window','document','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const root=createRoot(dom.window.document.getElementById('root')!);
  t.after(async()=>{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);});
  let completed!:(value:{ok:boolean;request?:WorkspaceRequest})=>void;
  const result=new Promise<{ok:boolean;request?:WorkspaceRequest}>(resolve=>completed=resolve);
  await act(async()=>root.render(createElement(WorkspaceSurface,{value:view,api:f.api,onResult:(ok,request)=>completed({ok,request})})));
  const form=dom.window.document.querySelector('form')!;
  (form.elements.namedItem('title') as HTMLInputElement).value='Generated corrected Alex';
  (form.elements.namedItem('statement') as HTMLInputElement).value='The generated plan was rescheduled.';
  await act(async()=>{form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await result;});
  const outcome=await result;assert.equal(outcome.ok,true);assert.ok(outcome.request);assert.notEqual(outcome.request.personMemoryId,f.person.id);
  const next=await f.read(outcome.request);
  assert.equal(next.data.title,'Generated corrected Alex');assert.match(String(next.data.statement),/rescheduled/);
  assert.equal(f.node.memories.get(f.person.id).supersededBy,next.request.personMemoryId);
  const current=await f.read({template:'person',scope:{kind:'all'}});
  assert.ok(!(current.data.memories as {id:string}[]).some(item=>item.id===f.person.id),'the corrected Memory is absent from the current projection');
  const removed=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+f.a.rootId,headers:workbenchHeaders});assert.equal(removed.statusCode,200,removed.body);
  const after=await f.read({template:'person',scope:f.scope,personMemoryId:f.person.id});assert.doesNotMatch(JSON.stringify(after),/Generated Alex|Generated plan commitment/);
});

test('a withdrawal during an asynchronous Memory read drops old bodies and matter choice labels',async t=>{
  const f=await workbenchFixture(t),reader=f.node.featureServices.evidenceReader,read=reader.memoryPageAsync.bind(reader);
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
  reader.memoryPageAsync=async(...args)=>{const page=await read(...args);entered();await gate;return page;};
  const pending=f.read({template:'project',scope:f.scope,matterId:f.matter.id});await started;
  await f.withdraw();release();
  const after=await pending;assert.doesNotMatch(JSON.stringify(after),/Generated studio|Generated Alex|Generated plan commitment|reading.txt/);
  assert.deepEqual(after.commands.map(command=>command.id),['refresh']);
});

test('stopping the owning activation refuses workbench reads and owner commands without changing saved data',async t=>{
  const f=await workbenchFixture(t),view=await f.read({template:'project',scope:f.scope,matterId:f.matter.id});
  f.node.insightServices.quiesce();
  const read=await f.node.app.inject({url:workspacePath(view.request),headers:workbenchHeaders});assert.equal(read.statusCode,503,read.body);
  const command=await f.node.app.inject({method:'POST',url:'/api/assistant/workbench/commands',headers:workbenchHeaders,payload:{request:view.request,command:view.commands.find(item=>item.id==='matter.pause')}});
  assert.equal(command.statusCode,503,command.body);assert.equal(f.node.featureServices.assistantMatters.get(f.matter.id).revision,f.matter.revision);
  assert.equal(f.node.memories.get(f.person.id).status,'published');
});
