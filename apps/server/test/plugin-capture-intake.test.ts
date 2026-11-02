import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import Fastify,{type FastifyRequest} from 'fastify';
import {captureSchema,type CaptureInput} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore} from '../src/materials.js';
import {createAuthorizationPlatform} from '../src/plugins/authorization-platform.js';
import {centralServices,type RequestAuthority} from '../src/plugins/central-contracts.js';
import {captureIntakeContribution,captureIntakeReplacement,createCaptureIntake,captureIntakeDeclaration} from '../src/plugins/capture-intake.js';

const ownerToken='generated-capture-owner-token';
const capture=(deviceId='generated-phone-a'):CaptureInput=>captureSchema.parse({id:randomUUID(),deviceId,deviceName:'Generated phone',platform:'android',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:'Generated evidence only'});
const inputsAttachment=(input:CaptureInput,fileId:string)=>{input.metadata={version:1,observedAt:input.capturedAt,attachments:[fileId]};return input;};
const sourceItem=(externalId=randomUUID())=>({externalId,revision:'1',observedAt:new Date().toISOString(),title:'Generated source input',text:'Generated source body',kind:'file',layer:'snapshot',deleted:false});

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-capture-intake-'));
  const store=new Store(directory),materials=new MaterialStore(store),sources=new SourceStore(store),files=new FileStore(store,sources);
  const platform=createAuthorizationPlatform({ownerToken},{store,availableModelConnections:()=>[]});
  await platform.prepare();platform.bindRepositories({sources,files,materials});await platform.start();
  const intake=createCaptureIntake({}, {store,sources,files,materials,authorization:platform});
  await intake.prepare();intake.start();
  const app=Fastify(),pins=new WeakMap<FastifyRequest,RequestAuthority>();
  app.addContentTypeParser(['application/gzip','application/x-ndjson+gzip'],{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  app.setErrorHandler((error,_request,reply)=>{const value=error as Error&{statusCode?:number;status?:number;code?:string};reply.code(value.statusCode??value.status??500).send({error:value.code??'capture_intake_failed'});});
  app.addHook('onRequest',async request=>{pins.set(request,platform.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin}));});
  app.addHook('onResponse',async request=>{const pin=pins.get(request);if(pin)platform.releaseRequest(pin);});
  intake.routes(app,{request:request=>pins.get(request)});
  t.after(async()=>{await app.close();await intake.close();await platform.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-source',name:'Generated source',kind:'custom',deviceId:'generated-phone-a',platform:'android',enabled:true,retention:'archive'});
  const post=(path:string,token:string,body:unknown,contentType='application/json')=>app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${token}`,'content-type':contentType},payload:contentType==='application/gzip'?body as Buffer:JSON.stringify(body)});
  const bundleBody=(inputs:CaptureInput[])=>gzipSync(Buffer.from(inputs.map(input=>JSON.stringify(input)).join('\n')+'\n'));
  const upload=async(sourceId:string,name:string,bytes:Buffer)=>{const pending=files.begin({sourceId,item:{externalId:name,revision:'1',observedAt:new Date().toISOString(),title:name,kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});files.part(pending.uploadId,0,bytes,()=>{});return (await files.commit(pending.uploadId,()=>{})).id;};
  return {store,sources,files,materials,platform,intake,app,post,bundleBody,upload};
}

test('real gzip bundle keeps per-item receipts, rejects duplicate ids and never re-archives',async t=>{
  const f=await fixture(t);
  const fileId=await f.upload('generated-source','generated-attachment.txt',Buffer.from('Generated attachment bytes'));
  const before=f.store.db.prepare('SELECT count(*) n FROM captures').get() as {n:number};
  const duplicated=capture();
  const rejected=await f.post('/api/captures/bundle',ownerToken,f.bundleBody([duplicated,duplicated]),'application/gzip');
  assert.equal(rejected.statusCode,400,rejected.body);
  assert.equal((f.store.db.prepare('SELECT count(*) n FROM captures').get() as {n:number}).n,before.n);

  const attached=inputsAttachment(capture(),fileId);
  const inputs=[capture(),attached];
  const accepted=await f.post('/api/captures/bundle',ownerToken,f.bundleBody(inputs),'application/gzip');
  assert.equal(accepted.statusCode,200,accepted.body);
  const results=accepted.json().results as Array<{id:string;status:number;receipt:{version:number;state:string;duplicate:boolean}}>;
  assert.deepEqual(results.map(result=>result.id),inputs.map(input=>input.id));
  assert.deepEqual(results.map(result=>result.status),[201,201]);
  assert.ok(results.every(result=>result.receipt.version===2&&result.receipt.state==='received'&&result.receipt.duplicate===false));
  assert.equal(f.store.evidence([inputs[0].id]).length,1);

  const repeated=await f.post('/api/captures/bundle',ownerToken,f.bundleBody(inputs),'application/gzip');
  assert.equal(repeated.statusCode,200,repeated.body);
  const repeatedResults=repeated.json().results as Array<{status:number;receipt:{duplicate:boolean}}>;
  assert.deepEqual(repeatedResults.map(result=>result.status),[200,200]);
  assert.ok(repeatedResults.every(result=>result.receipt.duplicate===true));
  assert.deepEqual(inputs.map(input=>f.store.evidence([input.id]).length),[1,1]);

  const batchDuplicate=await f.post('/api/captures/batch',ownerToken,{captures:[duplicated,duplicated]});
  assert.equal(batchDuplicate.statusCode,400,batchDuplicate.body);
  const openBatch=await f.post('/api/captures/batch',ownerToken,{captures:[capture()]});
  assert.equal(openBatch.statusCode,200,openBatch.body);
  assert.equal((openBatch.json().results as Array<{status:number}>)[0]!.status,201);
});

test('collector attachments stay on the admitted device and revoked grants stop late writes',async t=>{
  const f=await fixture(t),foreignSource='generated-source-b';
  f.sources.register({id:foreignSource,name:'Generated other device',kind:'custom',deviceId:'generated-phone-b',platform:'android',enabled:true,retention:'archive'});
  const foreignFile=await f.upload(foreignSource,'generated-foreign.txt',Buffer.from('Generated foreign bytes'));
  const invitation=f.platform.assembly.connections!.invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId:'generated-phone-a'},'collector');
  const paired=await f.platform.assembly.connections!.redeem({code:invitation.invitation.code,deviceId:'generated-phone-a',deviceName:'Generated phone',platform:'android'});
  const accepted=await f.post('/api/captures',paired.token,capture());
  assert.equal(accepted.statusCode,201,accepted.body);
  const attached=capture();attached.metadata={version:1,observedAt:attached.capturedAt,attachments:[foreignFile]};
  const foreign=await f.post('/api/captures',paired.token,attached);
  assert.equal(foreign.statusCode,403,foreign.body);
  const otherDevice=await f.post('/api/captures',paired.token,capture('generated-phone-b'));
  assert.equal(otherDevice.statusCode,403,otherDevice.body);

  await f.platform.assembly.connections!.revoke(paired.credentialId);
  const revoked=await f.post('/api/captures',paired.token,capture());
  assert.ok([401,403].includes(revoked.statusCode),revoked.body);
  const owner=await f.post('/api/captures',ownerToken,capture());
  assert.equal(owner.statusCode,201,owner.body);
  const sibling=await f.post('/api/captures',ownerToken,capture('generated-phone-b'));
  assert.equal(sibling.statusCode,201,sibling.body);
});

test('actual intake output is readable through the published source repository',async t=>{
  const f=await fixture(t),raw=sourceItem();
  const pin=f.platform.bindRequest({authorization:`Bearer ${ownerToken}`,method:'PUT',route:'/api/sources/:id/items',params:{id:'generated-source'}});
  try{
    const received=await f.platform.withSource(pin,'generated-source',raw,()=>f.intake.ports.sourceIntake.sourceItem('generated-source',raw,f.platform.commits.capture()));
    assert.equal(received.receipt.state,'received');
    assert.equal(received.duplicate,false);
  }finally{f.platform.releaseRequest(pin);}
  const item=f.intake.ports.sources.getItem('generated-source',raw.externalId);
  assert.equal(item?.revision,'1');
  assert.equal(item?.sourceId,'generated-source');
  assert.equal(f.intake.ports.sources.getSource('generated-source').deviceId,'generated-phone-a');
  assert.equal(f.intake.ports.sources.listItems({sourceId:'generated-source'}).items.length,1);
  assert.equal(f.intake.ports.sources.history('generated-source',raw.externalId).length,1);
  const page=await f.post('/api/captures',ownerToken,capture());
  assert.equal(page.statusCode,201,page.body);
  const importCapture=page.json() as {id:string};
  assert.equal(f.store.evidence([importCapture.id]).length,1);
});

test('quiescing the plugin rejects new intake and keeps the platform authoritative',async t=>{
  const f=await fixture(t);
  assert.equal(captureIntakeReplacement,'restart');
  assert.deepEqual(captureIntakeContribution.provides.map(service=>service.id).sort(),[centralServices.captureIntake.id,centralServices.sources.id,centralServices.sourceIntake.id].sort());
  assert.equal(captureIntakeDeclaration.apiVersion,'1');
  f.intake.quiesce('shutdown');
  const stopped=await f.post('/api/captures',ownerToken,capture());
  assert.equal(stopped.statusCode,503,stopped.body);
  await f.intake.close();
  const disposed=await f.post('/api/captures',ownerToken,capture());
  assert.equal(disposed.statusCode,503,disposed.body);
  assert.equal(f.store.stats().captures,0);
});
