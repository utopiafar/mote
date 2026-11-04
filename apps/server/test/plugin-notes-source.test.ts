import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {noteCapture,noteSchema} from '@mote/shared';
import {PluginHost} from '@mote/plugin-host';
import type {ScopeIdentity} from '@mote/plugin-api/contracts';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore} from '../src/materials.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {createAuthorizationPlatform} from '../src/plugins/authorization-platform.js';
import {createCaptureIntake} from '../src/plugins/capture-intake.js';
import type {RequestAuthority} from '../src/plugins/central-contracts.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {MaterialNoteDeletion} from '../src/material-note-deletion.js';
import {notesFeature} from '../src/features/notes.js';
import {FeatureScope} from '../src/features/index.js';
import {createNotesSource,createNotesSourceFactory,notesSourceContribution,notesSourceDeclaration} from '../src/plugins/notes-source.js';

async function fixture(t:any){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-notes-source-'));
  const config:Config={dataDir,token:'generated-notes-source-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in notes-source fixture');},close:async()=>{}}});
  const source=createNotesSource({
    page:args=>node.store.list({...args,source:'note'}),
    attribution:record=>node.materials.contextForEvidence(record),
    evidence:ids=>node.store.evidence(ids),
    deleteNote:id=>node.store.delete(id),
    noteDeletion:new MaterialNoteDeletion(node.store,node.materials),
  });
  await source.prepare();source.start();
  const app=Fastify(),pins=new WeakMap<object,RequestAuthority>();
  app.addHook('onRequest',async request=>{if(!request.headers.authorization)return;pins.set(request,node.authorizationPlatform.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin}));});
  app.addHook('onResponse',async request=>{const pin=pins.get(request);if(pin)node.authorizationPlatform.releaseRequest(pin);});
  notesFeature({assertRequestActive:node.featureServices.assertRequestActive,connections:node.featureServices.connections,credential:node.featureServices.credential,diagnostics:node.featureServices.diagnostics,files:node.featureServices.files,ingress:node.featureServices.ingress,notesSource:source.assemblyForRoutes(),notesCapture:{authority:node.authorizationPlatform,route:{request:request=>pins.get(request)},intake:node.captureIntake.ports.captureIntake}}).mount(app,new FeatureScope());
  await app.ready();
  t.after(async()=>{await app.close();await source.close();await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  return {node,source,app,assembly:source.assemblyForRoutes(),headers:{authorization:'Bearer '+config.token}};
}
async function intakeFixture(t:any){
  const directory=mkdtempSync(join(tmpdir(),'mote-notes-intake-')),store=new Store(directory),materials=new MaterialStore(store),sources=new SourceStore(store),files=new FileStore(store,sources);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),level:'debug'});await diagnostics.init();
  const intake=createCaptureIntake({diagnostics},{store,sources,files,materials});await intake.prepare();
  const ownerToken='generated-notes-intake-token';
  const platform=createAuthorizationPlatform({ownerToken},{store,availableModelConnections:()=>[]});
  await platform.prepare();platform.bindRepositories({sources,files,materials,ingress:intake.ingress});await platform.start();intake.bindAuthorization(platform);intake.start();
  sources.register({id:'generated-note-source',name:'Generated notes',kind:'custom',deviceId:'generated-note-device',platform:'android',enabled:true,retention:'archive'});
  const source=createNotesSource({page:args=>store.list({...args,source:'note'}),attribution:record=>materials.contextForEvidence(record),evidence:ids=>store.evidence(ids),deleteNote:id=>store.delete(id),noteDeletion:new MaterialNoteDeletion(store,materials)});
  await source.prepare();source.start();
  const app=Fastify(),pins=new WeakMap<object,RequestAuthority>();
  app.setErrorHandler((error,_request,reply)=>{const value=error as Error&{statusCode?:number;status?:number;code?:string};reply.code(value.statusCode??value.status??500).send({error:value.code??'notes_intake_failed'});});
  app.addHook('onRequest',async request=>{pins.set(request,platform.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin}));});
  app.addHook('onResponse',async request=>{const pin=pins.get(request);if(pin)platform.releaseRequest(pin);});
  notesFeature({assertRequestActive:()=>{},connections:platform.assembly.connections!,credential:()=>undefined,diagnostics,files,ingress:intake.ingress,notesSource:source.assemblyForRoutes(),notesCapture:{authority:platform,route:{request:request=>pins.get(request)},intake:intake.ports.captureIntake}}).mount(app,new FeatureScope());
  await app.ready();
  t.after(async()=>{await app.close();await source.close();await intake.close();await platform.close();await diagnostics.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,sources,platform,intake,app,headers:{authorization:'Bearer '+ownerToken}};
}
const note=(changes:Record<string,unknown>={})=>({id:randomUUID(),deviceId:'generated-note-device',deviceName:'Generated device',platform:'android',capturedAt:'2026-11-02T10:00:00.000Z',text:'  Generated note body\nwith original spacing.  ',...changes});

test('real HTTP note list keeps cursor, attribution and note-only deletion over current production readers',async t=>{
  const f=await fixture(t),ids:string[]=[];
  for(let i=0;i<3;i++){const input=note({id:randomUUID(),capturedAt:`2026-11-02T10:0${i}:00.000Z`,text:`Generated note ${i}`});ids.push(input.id);const created=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:input});assert.equal(created.statusCode,201,created.body);}
  const first=note({text:'Generated duplicate'}),again=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:first});assert.equal(again.statusCode,201);
  assert.equal((await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:{...first,text:'changed'}})).statusCode,409);
  const duplicate=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:first});assert.equal(duplicate.statusCode,200,duplicate.body);
  await f.node.materialOrganizer.tick(100);
  const read=new Set<string>();let cursor:string|null=null,pages=0;
  do{
    const response=await f.app.inject({url:'/api/notes?limit=2'+(cursor?'&cursor='+cursor:'')});
    assert.equal(response.statusCode,200,response.body);const page=response.json();pages++;
    if(pages===1)assert.equal(page.totalCount,4,'the notes-source page must preserve the fallback totalCount');
    for(const item of page.items){assert.ok(!read.has(item.id));read.add(item.id);assert.equal(item.source,'note');assert.equal(typeof item.attributionContext,'object');}
    cursor=page.nextCursor;
  }while(cursor);
  assert.equal(pages,2);assert.deepEqual(read,new Set([...ids,first.id]));
  const screen={...noteCapture(noteSchema.parse(note())),id:randomUUID(),source:'screen'};
  await f.node.store.ingest(screen);
  assert.equal((await f.app.inject({method:'DELETE',url:'/api/notes/'+screen.id})).statusCode,404);
  assert.ok(f.node.store.evidence([screen.id])[0]);
  const material=f.node.materials.list({kind:'mote.note'}).items.find(item=>item.origin.externalId===first.id);assert.ok(material);
  const anchor=f.node.materials.evidenceIds(material.ref,['record'])[0];assert.ok(anchor);
  assert.deepEqual(f.assembly.resolve(anchor),{virtual:true,captureId:first.id});
  assert.deepEqual(f.assembly.delete(anchor),{deleted:0},'notes deletion must not consume a Material alias');
  assert.ok(f.node.store.evidence([first.id])[0]);
  assert.deepEqual((await f.app.inject({method:'DELETE',url:'/api/notes/'+first.id})).json(),{deleted:1});
  assert.deepEqual((await f.app.inject({method:'DELETE',url:'/api/notes/'+first.id})).json(),{deleted:0});
});

test('C10A intake POST keeps note 201/200/409 and collector device semantics',async t=>{
  const f=await intakeFixture(t),input=note();
  const created=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:input});
  assert.equal(created.statusCode,201,created.body);
  const receipt=created.json();assert.equal(receipt.receipt.version,2);assert.equal(receipt.receipt.state,'received');assert.equal(receipt.duplicate,false);
  assert.equal((await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:input})).statusCode,200);
  assert.equal((await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:{...input,text:'Generated changed body'}})).statusCode,409);
  assert.equal(f.store.evidence([input.id])[0].source,'note');
  const invitation=f.platform.assembly.connections!.invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId:'generated-note-device'},'collector');
  const paired=await f.platform.assembly.connections!.redeem({code:invitation.invitation.code,deviceId:'generated-note-device',deviceName:'Generated phone',platform:'android'});
  const collector={authorization:'Bearer '+paired.token};
  assert.equal((await f.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note({id:randomUUID(),deviceId:'generated-note-device'})})).statusCode,201);
  assert.equal((await f.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note({id:randomUUID(),deviceId:'generated-other'})})).statusCode,403);
  await f.platform.assembly.connections!.revoke(paired.credentialId);
  const revoked=await f.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note({id:randomUUID(),deviceId:'generated-note-device'})});
  assert.ok([401,403].includes(revoked.statusCode),revoked.body);
  f.intake.quiesce('shutdown');
  const quiesced=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:note({id:randomUUID()})});
  assert.equal(quiesced.statusCode,503,quiesced.body);
  await f.intake.close();
  const closed=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:note({id:randomUUID()})});
  assert.equal(closed.statusCode,503,closed.body);
});

test('notes-source quiesce keeps reads but refuses new delete, and the factory mounts with no published service',async t=>{
  const f=await fixture(t),created=await f.app.inject({method:'POST',url:'/api/notes',headers:f.headers,payload:note()});assert.equal(created.statusCode,201);
  await f.source.quiesce('upgrade');
  assert.equal((await f.app.inject({url:'/api/notes'})).statusCode,200);
  assert.equal((await f.app.inject({method:'DELETE',url:'/api/notes/'+created.json().id})).statusCode,503);
  assert.throws(()=>f.source.assemblyForRoutes(),{statusCode:503});
  assert.equal(notesSourceContribution.provides?.length,0);
  const host=new PluginHost({kind:'central',id:'generated-notes-host'}),identity:ScopeIdentity={packageId:'generated.notes',installationId:'generated-install',instanceId:'generated-notes',activationId:'generated-activation',host:{kind:'central',id:'generated-notes-host'}};
  t.after(()=>host.close());
  await host.install({identity,restartRequired:false,contributions:[notesSourceDeclaration],factory:createNotesSourceFactory({
    page:args=>f.node.store.list({...args,source:'note'}),attribution:record=>f.node.materials.contextForEvidence(record),
    evidence:ids=>f.node.store.evidence(ids),deleteNote:id=>f.node.store.delete(id),noteDeletion:new MaterialNoteDeletion(f.node.store,f.node.materials),
  })});
  assert.equal(host.snapshot().contributions.find(item=>item.identity.contributionId==='notes-source')?.availability.state,'active');
});
