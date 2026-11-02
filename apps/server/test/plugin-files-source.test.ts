import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {FILE_PART_BYTES,type FileRevision} from '@mote/shared';
import {PluginHost} from '@mote/plugin-host';
import type {ScopeIdentity,ServiceBinding} from '@mote/plugin-api/contracts';
import {Store,StoreError,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ServerFeatureScope} from '../src/feature-host.js';
import {register as registerFilesFeature} from '../src/features/files.js';
import {IngressService} from '../src/ingress.js';
import type {FileProcessing} from '../src/file-processing.js';
import {registerFileRoutes} from '../src/file-routes.js';
import {ImportUploads} from '../src/import-uploads.js';
import {fileOriginalRawRef} from '../src/file-raw-reader.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {createFilesSource,createFilesSourceFactory,filesSourceContribution,filesSourceDeclaration,filesSourceReplacement,PlaybackGrants} from '../src/plugins/files-source.js';

const sourceId='generated-phone';
function fixture(t:any,options:{sweepIntervalMs?:number;clock?:()=>number}={}){
  const directory=mkdtempSync(join(tmpdir(),'mote-files-source-'));
  const store=new Store(directory,{maxStorageBytes:200*1024*1024}),sources=new SourceStore(store);
  sources.register({id:sourceId,name:'Generated phone',kind:'local-files',deviceId:sourceId,platform:'android',retention:'archive'});
  const archivedFiles=new ArchivedFileStore(store),allowed={value:true};
  const source=createFilesSource({store,sources,archivedFiles,rawAccess:{
    mayReadFileVersion:()=>allowed.value,mayReadArchivedFile:()=>allowed.value,
    mayListSourceFiles:()=>allowed.value,mayListArchivedFiles:()=>allowed.value,
  }},{sweepIntervalMs:options.sweepIntervalMs??0,...(options.clock?{clock:options.clock}:{})});
  t.after(async()=>{await source.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,sources,archivedFiles,source,allowed};
}
function manifest(bytes:Buffer,revision='v1'):FileRevision {
  return {sourceId,previousRevision:null,item:{externalId:'content://generated/radio',revision,observedAt:'2026-11-02T00:00:00Z',title:'Synthetic radio.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false},
    relativePath:'generated/radio.wav',sizeBytes:bytes.length,sha256:sha256(bytes)};
}
function routes(fixture:{store:Store;sources:SourceStore;source:ReturnType<typeof createFilesSource>;allowed:{value:boolean}}){
  const app=Fastify(),files=fixture.source.assemblyForRoutes().files,ingress=new IngressService(fixture.store,fixture.sources,files);
  const authorize=(_req:unknown,_source:string)=>{if(!fixture.allowed.value)throw new StoreError('Source is not authorized',403);};
  const playback=fixture.source.assemblyForRoutes().playback;
  const verify=registerFileRoutes(app,files,{} as FileProcessing,ingress,authorize as any,()=>undefined,{evidence:()=>[{}]} as any,undefined,async(_id:string,task:()=>unknown)=>task(),async(_ids:readonly string[],task:()=>unknown)=>task(),playback);
  return {app,verify};
}

test('real SQLite/blob loopback upload replays a lost part and lost final ACK to one revision, ID and byte set',async t=>{
  const f=fixture(t);await f.source.prepare();f.source.start();
  const {app}=routes(f);t.after(()=>app.close());
  const bytes=Buffer.alloc(FILE_PART_BYTES+4321,7),input=manifest(bytes);
  const started=await app.inject({method:'POST',url:'/api/file-sync/v1/uploads',payload:input});
  assert.equal(started.statusCode,200,started.body);
  const session=started.json(),partsUrl=`/api/file-sync/v1/uploads/${session.uploadId}/parts`;
  const part0=bytes.subarray(0,FILE_PART_BYTES),first=await app.inject({method:'PUT',url:`${partsUrl}/0`,headers:{'content-type':'application/octet-stream'},payload:part0});
  assert.equal(first.statusCode,200,first.body);
  const resent=await app.inject({method:'PUT',url:`${partsUrl}/0`,headers:{'content-type':'application/octet-stream'},payload:part0});
  assert.equal(resent.statusCode,200,resent.body);assert.deepEqual(resent.json(),first.json(),'a lost part ACK must replay the same hash/offset');
  const second=await app.inject({method:'PUT',url:`${partsUrl}/1`,headers:{'content-type':'application/octet-stream'},payload:bytes.subarray(FILE_PART_BYTES)});
  assert.equal(second.statusCode,200,second.body);
  const committed=await app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${session.uploadId}/commit`,payload:{}});
  assert.equal(committed.statusCode,200,committed.body);const ack=committed.json();
  const finalReplay=await app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${session.uploadId}/commit`,payload:{}});
  assert.equal(finalReplay.statusCode,200,finalReplay.body);assert.deepEqual(finalReplay.json(),ack,'a lost final ACK must replay the same receipt');
  const beginAgain=await app.inject({method:'POST',url:'/api/file-sync/v1/uploads',payload:input});
  assert.equal(beginAgain.statusCode,200,beginAgain.body);
  assert.equal(beginAgain.json().ack?.id,ack.id);assert.equal(beginAgain.json().ack?.duplicate,true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM file_versions').get()!.n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM file_uploads WHERE ack IS NOT NULL').get()!.n,1);
  assert.deepEqual(Buffer.concat([...f.source.assemblyForRoutes().files.bytes(ack.id)]),bytes);
});

test('revoked source and closed plugin reject a late final without publishing, and playback grants die with the scope',async t=>{
  const f=fixture(t);await f.source.prepare();f.source.start();
  const files=f.source.assemblyForRoutes().files,bytes=Buffer.from('Generated authorized bytes'),input=manifest(bytes);
  const upload=files.begin(input,()=>{if(!f.allowed.value)throw new StoreError('Source is not authorized',403);});
  files.part(upload.uploadId,0,bytes,()=>{if(!f.allowed.value)throw new StoreError('Source is not authorized',403);});
  f.allowed.value=false;
  await assert.rejects(files.commit(upload.uploadId,()=>{throw new StoreError('Source is not authorized',403);}),{statusCode:403});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM file_versions').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);
  f.allowed.value=true;
  // The same durable session resumes once the current grant returns.
  const recovered=await files.commit(upload.uploadId,()=>{});
  assert.deepEqual(Buffer.concat([...files.bytes(recovered.id)]),bytes);

  const playback=f.source.assemblyForRoutes().playback,authorized=()=>{if(!f.allowed.value)throw new StoreError('Source is not authorized',403);};
  const grant=playback.issue(recovered.id,sourceId,authorized),wrongFile=playback.issue(recovered.id,sourceId,authorized);
  assert.equal(playback.verify(recovered.id,grant.token),true);
  assert.equal(playback.verify('00000000-0000-4000-8000-000000000000',wrongFile.token),false);
  assert.equal(playback.verify(recovered.id,wrongFile.token),true,'a wrong-file probe must not revoke another file grant');
  f.allowed.value=false;assert.equal(playback.verify(recovered.id,grant.token),false,'a revoked source check invalidates the token');
  f.allowed.value=true;
  const fresh=playback.issue(recovered.id,sourceId,authorized);
  assert.equal(playback.verify(recovered.id,fresh.token),true,'a fresh grant verifies before retirement');

  const late=files.begin(manifest(Buffer.from('Generated late final'),'v2'),()=>{});
  files.part(late.uploadId,0,Buffer.from('Generated late final'),()=>{});
  await f.source.stop('disabled');
  assert.equal(f.store.db.isOpen,true,'the borrowed C02 Store must stay open');
  assert.equal(playback.verify(recovered.id,fresh.token),false,'scope retirement invalidates live playback tokens');
  assert.throws(()=>playback.issue(recovered.id,sourceId,()=>{}),{statusCode:503});
  assert.throws(()=>files.part(late.uploadId,0,Buffer.from('Generated late final'),()=>{}),{statusCode:503});
  await assert.rejects(files.commit(late.uploadId,()=>{}),{statusCode:503});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM file_versions').get()!.n,1);
});

test('closed files source rejects late metadata revisions and manifest batches without publishing',async t=>{
  const f=fixture(t);await f.source.prepare();f.source.start();
  const files=f.source.assemblyForRoutes().files;
  await f.source.stop('disabled');
  const base=manifest(Buffer.alloc(0),'late'),reference:FileRevision={...base,item:{...base.item,layer:'reference',title:'Late reference'},sizeBytes:10**12};
  delete (reference as {sha256?:string}).sha256;
  await assert.rejects(files.revision(reference,()=>{}),{statusCode:503});
  await assert.rejects(files.manifestBatch({items:[{sourceId,previousRevision:null,item:reference.item}]},()=>{}),{statusCode:503});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM file_versions').get()!.n,0);
});

test('HTTP playback cookie is scoped to the issuing file and stops verifying after quiesce',async t=>{
  const f=fixture(t,{clock:()=>1000});await f.source.prepare();f.source.start();
  const {app,verify}=routes(f);t.after(()=>app.close());
  const bytes=Buffer.from('Generated playback bytes'),input=manifest(bytes),files=f.source.assemblyForRoutes().files;
  const upload=files.begin(input,()=>{});files.part(upload.uploadId,0,bytes,()=>{});const ack=await files.commit(upload.uploadId,()=>{});
  const response=await app.inject({method:'POST',url:`/api/files/${ack.id}/playback`,payload:{}});
  assert.equal(response.statusCode,200,response.body);
  const cookie=String(response.headers['set-cookie']).split(';')[0];
  assert.match(String(response.headers['set-cookie']),/Max-Age=300(?:;|$)/,'cookie lifetime must use the registry clock, not wall time');
  const request={routeOptions:{url:'/api/files/:id/content'},method:'GET',params:{id:ack.id},headers:{cookie}} as any;
  assert.equal(verify(request),true);
  assert.equal(verify({...request,params:{id:'00000000-0000-4000-8000-000000000000'}}),false);
  f.source.quiesce('disabled');
  assert.equal(verify(request),false);
});

test('files-source factory publishes only the read-only original port and closes with its host scope',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-files-port-')),store=new Store(directory),sources=new SourceStore(store);
  sources.register({id:sourceId,name:'Generated phone',kind:'local-files',deviceId:sourceId,platform:'android',retention:'archive'});
  const archivedFiles=new ArchivedFileStore(store);
  const seed=new FileStore(store,sources),bytes=Buffer.from('Generated port bytes'),input=manifest(bytes);
  const upload=seed.begin(input,()=>{});seed.part(upload.uploadId,0,bytes,()=>{});const ack=await seed.commit(upload.uploadId,()=>{});
  const host=new PluginHost({kind:'central',id:'generated-host'}),identity:ScopeIdentity={packageId:'generated.files',installationId:'generated-install',instanceId:'generated-files',activationId:'generated-activation',host:{kind:'central',id:'generated-host'}};
  let binding:ServiceBinding|undefined;
  t.after(async()=>{await host.close();await seed.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const factory=createFilesSourceFactory({store,sources,archivedFiles,rawAccess:{mayReadFileVersion:()=>true,mayReadArchivedFile:()=>false,mayListSourceFiles:()=>false,mayListArchivedFiles:()=>false}},{sweepIntervalMs:0});
  await host.install({identity,restartRequired:false,contributions:[filesSourceDeclaration],factory:(context)=>{
    return factory({...context,provide:(id,contract,value,revision)=>{
      const created=context.provide(id,contract,value,revision);
      if(contract.id===centralServices.fileOriginalRead.id)binding=created;
      return created;
    }});
  }});
  const lease=await host.acquire(centralServices.fileOriginalRead,binding!),port=lease.value;
  assert.deepEqual(Object.keys(port),['read']);
  const page=await port.read(fileOriginalRawRef(ack.id,ack.sha256),{offset:0,length:bytes.length});
  assert.equal(page.status,'available');if(page.status==='available')assert.deepEqual(Buffer.from(page.bytes),bytes);
  assert.equal(filesSourceContribution.requires?.[0].id,'mote.vault-platform');
  assert.deepEqual(filesSourceContribution.provides?.map(service=>service.id),[centralServices.fileOriginalRead.id]);
  assert.equal(filesSourceReplacement,'hot');
  await host.close();
  assert.equal(store.db.isOpen,true,'the plugin borrows C02 storage and must not close it');
  assert.throws(()=>port.read(fileOriginalRawRef(ack.id,ack.sha256),{offset:0,length:1}));
});

test('import upload transport refuses a late final after its owner closes without touching ImportStore',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-close-')),store=new Store(directory),archived=new ArchivedFileStore(store);
  const uploads=new ImportUploads(store,archived),bytes=Buffer.from('Generated import bytes'),upload=uploads.begin({name:'generated.txt',sizeBytes:bytes.length});
  t.after(async()=>{await uploads.close();store.close();rmSync(directory,{recursive:true,force:true});});
  uploads.part(upload.id,0,bytes);
  const firstClose=uploads.close(),secondClose=uploads.close();
  assert.equal(firstClose,secondClose,'concurrent close must join the same drain');
  await Promise.all([firstClose,secondClose]);
  assert.throws(()=>uploads.begin({name:'generated.txt',sizeBytes:bytes.length}),{statusCode:503});
  await assert.rejects(uploads.commit(upload.id),{statusCode:503});
  assert.equal(store.db.prepare('SELECT count(*) n FROM archived_files').get()!.n,0);
});

test('mote.files feature registration never closes the plugin-owned FileStore and retires its bypass on scope stop',async t=>{
  const f=fixture(t);await f.source.prepare();f.source.start();
  const app=Fastify(),scope=new ServerFeatureScope();t.after(async()=>{await app.close();});
  let playback:(req:unknown)=>boolean=()=>true;
  registerFilesFeature(app,{
    files:f.source.assemblyForRoutes().files,processing:{prepare(){},close(){}} as any,ingress:{} as any,
    sourceOwner:()=>{},credential:()=>undefined,evidenceReader:{evidence:()=>[{}]} as any,
    executor:{tick:()=>0} as any,withMediaOwnerIntent:async(_id:string,task:()=>unknown)=>task(),
    withMediaOwnerBatch:async(_ids:readonly string[],task:()=>unknown)=>task(),
    setPlaybackAuthorization:(value:(req:unknown)=>boolean)=>{playback=value;},
    filesSource:{playback:f.source.assemblyForRoutes().playback},
  } as any,scope);
  await app.ready();
  await scope.close();
  const request={routeOptions:{url:'/api/files/:id/content'},method:'GET',params:{id:'00000000-0000-4000-8000-000000000000'},headers:{}};
  assert.equal(playback(request),false,'feature retire must revoke its playback bypass');
  const files=f.source.assemblyForRoutes().files,bytes=Buffer.from('Generated after feature dispose'),upload=files.begin(manifest(bytes),()=>{});
  assert.ok(upload.uploadId,'a feature scope must not close the plugin-owned FileStore');
  files.part(upload.uploadId,0,bytes,()=>{});
  await files.commit(upload.uploadId,()=>{});
});

test('playback registry purges expired tokens and fails closed for forged checks',()=>{
  let now=1000;const grants=new PlaybackGrants({ttlMs:100,clock:()=>now,token:()=> 'a'.repeat(64)});
  const revoked=grants.issue('00000000-0000-4000-8000-000000000001',sourceId,()=>{throw new StoreError('revoked',401);});
  assert.equal(grants.verify('00000000-0000-4000-8000-000000000001',revoked.token),false);
  const expiring=grants.issue('00000000-0000-4000-8000-000000000001',sourceId,()=>{});
  assert.equal(grants.verify('00000000-0000-4000-8000-000000000001',expiring.token),true);
  now+=101;assert.equal(grants.verify('00000000-0000-4000-8000-000000000001',expiring.token),false);
  grants.retire();assert.equal(grants.active,false);
  assert.throws(()=>grants.issue('00000000-0000-4000-8000-000000000001',sourceId,()=>{}),{statusCode:503});
});
