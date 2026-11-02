import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import Fastify,{type FastifyRequest} from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {captureSchema} from '@mote/shared';
import {ConfigService} from '../src/config-service.js';
import {ExecutionSettings,executionSettingsSchema} from '../src/execution-settings.js';
import {MaterialStore} from '../src/materials.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {FileStore} from '../src/files.js';
import {SourceStore} from '../src/sources.js';
import {Connections} from '../src/connections.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {LayersReadModel} from '../src/layers-read-model.js';
import {MaterialNoteDeletion} from '../src/material-note-deletion.js';
import {EvidenceDeletion} from '../src/evidence-deletion.js';
import {registerCaptureBrowser} from '../src/capture-browser.js';
import {register as registerNotes} from '../src/features/notes.js';
import {createNotesSource} from '../src/plugins/notes-source.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {sha256} from '../src/store.js';
import {createVaultPlatformAssembly} from '../src/plugins/vault-platform.js';
import {createAuthorizationPlatform} from '../src/plugins/authorization-platform.js';
import {createExecutionPlatform} from '../src/plugins/execution-platform.js';
import {createSourceRuntime,createSourceRuntimeFactory,sourceRuntimeDeclaration} from '../src/plugins/source-runtime.js';
import {createCaptureIntake} from '../src/plugins/capture-intake.js';
import {createC10Integration,createC10IntegrationFactory,c10IntegrationDeclaration,c10IntegrationContribution} from '../src/plugins/c10-integration.js';
import type {RequestAuthority} from '../src/plugins/central-contracts.js';

const ownerToken='generated-c10-owner';
const identity=()=>({packageId:'generated.c10',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID(),host:{kind:'central' as const,id:'generated-c10-host'}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const item=(externalId='one')=>({externalId,revision:'1',observedAt:new Date().toISOString(),kind:'message',layer:'original',text:'Generated C10 original '+externalId});
async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-c10-')),vault=createVaultPlatformAssembly({dataDir:directory});await vault.prepare();const store=vault.store;
  const config=new ConfigService({path:join(directory,'mote.yaml'),initialDocument:{version:1,revision:0},watch:false});config.register({id:'execution',schema:executionSettingsSchema,defaultValue:executionSettingsSchema.parse({})});await config.initialize();
  const materials=new MaterialStore(store),memoryWork=new MaterialMemoryWork(store,materials),sources=new SourceStore(store,undefined,memoryWork.inputs),connections=new Connections(store,sources),authorization=createAuthorizationPlatform({ownerToken},{store,connections,availableModelConnections:()=>[]});await authorization.prepare();
  const execution=createExecutionPlatform({store,settings:new ExecutionSettings(config),modelAuthorization:authorization.assembly.modelAuthorization});await execution.prepare();execution.start();
  const host=new PluginHost({kind:'central',id:'generated-c10-host'}),runtimePlatform=createSourceRuntime({plugins:[codingSourcePlugin]},{store,materials,memoryWork,execution});
  await host.install({identity:identity(),contributions:[sourceRuntimeDeclaration],factory:createSourceRuntimeFactory(runtimePlatform)});
  const runtime=runtimePlatform.runtimeForAssembly;sources.pipelines=runtime;
  const integration=createC10Integration({store,runtime,memoryWork,sources}),files=new FileStore(store,sources);
  const capture=createCaptureIntake({}, {store,sources,files,materials});await capture.prepare();authorization.bindRepositories({sources,files,materials,ingress:capture.ingress,memoryInputs:memoryWork.inputs,memoryWork});await authorization.start();capture.bindAuthorization(authorization);capture.start();
  const reader=new EvidenceReader(store,sources,files,undefined,undefined,materials,runtime),diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  const noteDeletion=new MaterialNoteDeletion(store,materials),notes=createNotesSource({page:args=>store.list({...args,source:'note'}),attribution:record=>materials.contextForEvidence(record),evidence:ids=>store.evidence(ids),deleteNote:id=>store.delete(id),noteDeletion});await notes.prepare();notes.start();
  integration.bindRoutes({authorization,capture,files,evidenceReader:reader,layers:new LayersReadModel(sources,reader.memories)});
  const app=Fastify();app.addContentTypeParser(['application/gzip'],{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number;code?:string};reply.code(e.statusCode??500).send({error:e.code??e.message});});
  const owner=await host.install({identity:identity(),contributions:[c10IntegrationDeclaration],factory:createC10IntegrationFactory(integration,platform=>platform.routes(app))});
  app.register(async child=>{
    const pins=new WeakMap<FastifyRequest,RequestAuthority>();
    child.addHook('onRequest',async req=>{pins.set(req,authorization.bindRequest({authorization:req.headers.authorization,method:req.method,route:req.routeOptions.url!,params:req.params as {id?:string}}));});
    child.addHook('onResponse',async req=>{const pin=pins.get(req);if(pin)authorization.releaseRequest(pin);});
    const credential=(req:FastifyRequest)=>{authorization.requests.assertCurrent(pins.get(req)!);const c=connections.authenticate(req.headers.authorization);return c&&!connections.isOwner(c)?c:undefined;};
    const route={request:(req:FastifyRequest)=>pins.get(req)};
    capture.routes(child,route);
    registerNotes(child,{store,sources,files,materials,diagnostics,connections,credential,assertRequestActive:req=>authorization.requests.assertCurrent(pins.get(req)!),ingress:capture.ingress,notesSource:notes.assemblyForRoutes(),notesCapture:{authority:authorization,route,intake:capture.ports.captureIntake}});
    registerCaptureBrowser(child,{store,evidenceReader:reader,connections,credential,deletion:new EvidenceDeletion(store,files,noteDeletion)});
  });
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port;
  const http=(path:string,method='GET',body?:unknown,token=ownerToken)=>fetch(url+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':Buffer.isBuffer(body)?'application/gzip':'application/json'})},...(body===undefined?{}:{body:Buffer.isBuffer(body)?new Uint8Array(body):JSON.stringify(body)})});
  t.after(async()=>{await app.close();await notes.close();await host.close();await capture.close();await authorization.close();await execution.close();await files.close();await materials.index?.close();await diagnostics.close();await config.close();await vault.close();rmSync(directory,{recursive:true,force:true});});
  const pair=async(deviceId='generated-phone-a')=>{const invitation=connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId},'collector');return connections.redeem({code:invitation.invitation.code,deviceId,deviceName:'Generated phone',platform:'android'});};
  const register=async(id:string,deviceId='generated-phone-a',token=ownerToken)=>{const response=await http('/api/sources','POST',{id,name:'Generated source',kind:'custom',deviceId,platform:'android'},token);assert.equal(response.status,200,await response.clone().text());};
  return {store,materials,memoryWork,runtime,host,owner,integration,sources,files,capture,authorization,connections,http,pair,register};
}

test('source control binds real owner/collector request and actual device/platform without publishing an unguarded repository',async t=>{
  const f=await fixture(t),paired=await f.pair();await f.register('own','generated-phone-a',paired.token);await f.register('foreign','generated-phone-b');
  assert.equal((await f.http('/api/sources','POST',{id:'forged',name:'Generated forged',kind:'custom',deviceId:'generated-phone-a',platform:'macos'},paired.token)).status,403);
  assert.equal((await f.http('/api/sources','POST',{id:'foreign',name:'Generated collision',kind:'custom',deviceId:'generated-phone-a',platform:'android'},paired.token)).status,403);
  assert.equal((await f.http('/api/sources/foreign','PATCH',{enabled:false},paired.token)).status,403);
  assert.equal((await f.http('/api/sources/own','PATCH',{ownerRelation:'self'},paired.token)).status,403);
  const page=await (await f.http('/api/sources','GET',undefined,paired.token)).json();assert.deepEqual(page.items.map((s:{id:string})=>s.id),['own']);
  assert.equal((await f.http('/api/sources/own/context','PATCH',{expectedVersion:0,description:'Generated owner context'},paired.token)).status,403);
  assert.equal((await f.http('/api/sources/own/context','PATCH',{expectedVersion:0,description:'Generated owner context'})).status,200);
  assert.deepEqual(c10IntegrationContribution.provides,[]);assert.equal(f.sources.pipelines,f.runtime);assert.equal(f.sources.usesMemoryInputs(f.memoryWork.inputs),true);
  await f.connections.revoke(paired.credentialId);assert.equal((await f.http('/api/sources/own','PATCH',{enabled:false},paired.token)).status,401);assert.equal(f.sources.getSource('own').enabled,true);
});

test('formal Notes POST and gzip capture receipts share actual C10A intake and library originals with attachment bytes',async t=>{
  const f=await fixture(t);await f.register('attachment-source');assert.equal((await f.http('/api/sources/attachment-source','PATCH',{retention:'archive'})).status,200);
  const input={id:randomUUID(),deviceId:'generated-phone-a',deviceName:'Generated phone',platform:'android',capturedAt:new Date().toISOString(),text:'Generated owner note, retained verbatim.'};
  const note=await f.http('/api/notes','POST',input);assert.equal(note.status,201);assert.equal((await note.json()).receipt.id,input.id);
  assert.equal((await f.http('/api/notes','POST',input)).status,200);const page=await (await f.http('/api/notes')).json();assert.equal(page.totalCount,1);assert.equal(page.items[0].ocrText,input.text);
  const library=await f.http('/api/library/device-view','POST',{source:'note',after:'2020-01-01T00:00:00Z',before:'2030-01-01T00:00:00Z'});assert.equal(library.status,200);assert.equal((await library.json()).items[0].id,input.id);
  const pin=f.authorization.bindRequest({authorization:'Bearer '+ownerToken,method:'POST',route:'/api/file-sync/v1/begin'}),check=(source:string)=>f.authorization.requests.assertOwnSource(pin,source),bytes=Buffer.from('Generated immutable attachment bytes');let fileId:string;
  try{const upload=f.files.begin({sourceId:'attachment-source',item:{...item('attachment.txt'),kind:'file',mimeType:'text/plain',text:''},sizeBytes:bytes.length,sha256:sha256(bytes)},check);f.files.part(upload.uploadId,0,bytes,check);fileId=(await f.files.commit(upload.uploadId,check)).id;}finally{f.authorization.releaseRequest(pin);}
  const capture=captureSchema.parse({id:randomUUID(),deviceId:input.deviceId,deviceName:input.deviceName,platform:'android',capturedAt:input.capturedAt,durationMs:0,source:'note',ocrText:'Generated bundle original',metadata:{version:1,observedAt:input.capturedAt,attachments:[fileId]}}),body=gzipSync(Buffer.from(JSON.stringify(capture)+'\n'));
  const first=await f.http('/api/captures/bundle','POST',body);assert.equal(first.status,200);assert.equal((await first.json()).results[0].receipt.id,capture.id);
  const duplicate=await (await f.http('/api/captures/bundle','POST',body)).json();assert.equal(duplicate.results[0].duplicate,true);
  const browser=await f.http('/api/capture-browser/'+capture.id);assert.equal(browser.status,200);assert.equal((await browser.json()).ocrText,capture.ocrText);assert.equal(f.store.evidence([fileId])[0].deviceId,input.deviceId);
  assert.deepEqual(Buffer.concat([...f.files.bytes(fileId)]),bytes);
});

for(const revoke of ['source','credential','stop','quiesce'] as const)test(`actual source commit ${revoke} keeps authority and persistence boundaries`,async t=>{
  const f=await fixture(t),paired=await f.pair();await f.register('own','generated-phone-a',paired.token);await f.register('other');
  const entered=deferred(),release=deferred(),original=f.store.ingestBatch.bind(f.store);t.after(()=>release.resolve());
  t.mock.method(f.store,'ingestBatch',async(...args:Parameters<typeof original>)=>{if(args[0].some(input=>Boolean(input&&typeof input==='object'&&'provenance' in input&&input.provenance&&typeof input.provenance==='object'&&'externalId' in input.provenance&&input.provenance.externalId==='held'))){entered.resolve();await release.promise;}return original(...args);});
  const pending=f.http('/api/sources/own/items','PUT',item('held'),paired.token);await entered.promise;let closing:Promise<void>|undefined,drained=false;
  if(revoke==='source')assert.equal((await f.http('/api/sources/own','PATCH',{enabled:false})).status,200);
  if(revoke==='credential')await f.connections.revoke(paired.credentialId);
  if(revoke==='stop')closing=f.owner.close('disabled');
  if(revoke==='quiesce'){closing=f.owner.quiesce('upgrade');assert.equal((await f.http('/api/sources/other/items','PUT',item('fresh'))).status,503);}
  if(revoke==='source'||revoke==='credential')assert.equal((await f.http('/api/sources/other/items','PUT',item('independent'))).status,200);
  if(closing){closing=closing.then(()=>{drained=true;});await new Promise<void>(done=>setImmediate(done));assert.equal(drained,false,'owner must drain the accepted write before resolving shutdown');}
  release.resolve();const response=await pending;await closing;
  assert.equal(response.status,revoke==='quiesce'?200:revoke==='credential'?401:revoke==='source'?403:503,await response.clone().text());
  assert.equal(Boolean(f.sources.getItem('own','held')),revoke==='quiesce');assert.equal(f.store.db.isOpen,true);assert.equal(f.runtime.engine.closed,false);
  if(revoke==='stop')assert.equal((await f.http('/api/notes','POST',{id:randomUUID(),deviceId:'generated-phone-a',deviceName:'Generated',platform:'android',capturedAt:new Date().toISOString(),text:'Generated independent Notes owner'})).status,201);
});


test('scope loss inside a source registration transaction rolls back metadata without deleting prior sources',async t=>{
  const f=await fixture(t);await f.register('retained');const reserve=f.store.reserveMetadata.bind(f.store);let armed=true,closing:Promise<void>|undefined;
  t.mock.method(f.store,'reserveMetadata',(bytes:number)=>{if(armed){armed=false;closing=f.owner.close('revoked');}return reserve(bytes);});
  const response=await f.http('/api/sources','POST',{id:'late-registration',name:'Generated late source',kind:'custom',deviceId:'generated-phone-a',platform:'android'});
  assert.equal(response.status,503);await closing;assert.equal(f.sources.listSources().length,1);assert.equal(f.sources.getSource('retained').id,'retained');assert.equal(f.store.db.isOpen,true);
});

test('trusted archive ingestion keeps callback rejection and the original checkpoint contract',async t=>{
  const f=await fixture(t),response=await f.http('/api/sources','POST',{id:'coding',name:'Generated coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});assert.equal(response.status,200);
  const raw={...item('coding-event'),layer:'snapshot',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:'coding-event',role:'user',attribution:'human',part:0,parts:1}}};let callbacks=0;
  await assert.rejects(f.sources.upsert('coding',raw,undefined,()=>{callbacks++;}),{statusCode:409});assert.equal(callbacks,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,0);
  const received=await f.http('/api/sources/coding/items','PUT',raw);assert.equal(received.status,200);await f.runtime.tick();assert.equal(f.materials.list().items.length,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,1);
});


test('failed source owner startup retires only its own repository and preserves the borrowed vault and active owner',async t=>{
  const f=await fixture(t);await f.register('retained');const pending=new SourceStore(f.store,f.runtime,f.memoryWork.inputs),candidate=createC10Integration({store:f.store,runtime:f.runtime,memoryWork:f.memoryWork,sources:pending});
  await assert.rejects(f.host.install({identity:identity(),contributions:[c10IntegrationDeclaration],factory:createC10IntegrationFactory(candidate)}),{statusCode:503});
  await assert.rejects(pending.upsert('retained',item('late')),{statusCode:503});assert.equal(f.store.db.isOpen,true);assert.equal(f.sources.getSource('retained').enabled,true);
  assert.equal((await f.http('/api/sources/retained/items','PUT',item('active-owner'))).status,200);
  const otherMemory=new MaterialMemoryWork(f.store,f.materials);assert.throws(()=>createC10Integration({store:f.store,runtime:f.runtime,memoryWork:otherMemory,sources:f.sources}),{statusCode:503});
});
