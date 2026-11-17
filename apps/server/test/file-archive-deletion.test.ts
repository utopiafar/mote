import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type FileRevision,FILE_PART_BYTES} from '@mote/shared';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../src/app.js';
import {configurationFromFile} from '../src/config.js';
import {sha256} from '../src/evidence-store.js';
import {SourceSync} from '../../desktop/src/source-sync.js';
import {sourceState} from '../../desktop/src/source-state-store.js';
import type {ScannedItem,SourceDefinition,SourceRequest} from '../../desktop/src/source-types.js';

async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-archive-deletion-')),token='generated-archive-deletion-owner',path=join(directory,'mote.yaml');
 await writeFile(path,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token},storage:{dataDir:join(directory,'data')},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
 const start=()=>buildApp(configurationFromFile(path),{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model in archive deletion fixture');},async close(){}}});
 let node=await start(),origin=await node.app.listen({host:'127.0.0.1',port:0});
 const owner={authorization:'Bearer '+token,'x-mote-ingress-version':'2'},cleanup=new Set<()=>void>();
 t.after(async()=>{for(const release of cleanup)release();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const request=async(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>=owner)=>{
  const response=await fetch(origin+url,{method,headers:{...headers,...(payload===undefined?{}:{'content-type':Buffer.isBuffer(payload)?'application/octet-stream':'application/json'})},...(payload===undefined?{}:{body:Buffer.isBuffer(payload)?payload:JSON.stringify(payload)})}),rawPayload=Buffer.from(await response.arrayBuffer()),body=rawPayload.toString('utf8');
  return {statusCode:response.status,body,rawPayload,json:()=>JSON.parse(body)};
 };
 for(const [id,deviceId]of [['visible','generated-device'],['other','other-device']] as const){const response=await request('POST','/api/sources',{id,name:'Generated '+id,kind:'local-files',deviceId,platform:'macos',retention:'archive'});assert.equal(response.statusCode,200,response.body);}
 const invitation=await request('POST','/api/connections/collector-invitations',{serverUrl:origin,label:'Generated archive collector',deviceId:'generated-device'});assert.equal(invitation.statusCode,200,invitation.body);
 const collector=await request('POST','/api/connections/redeem',{code:invitation.json().invitation.code,deviceId:'generated-device',deviceName:'Generated archive device',platform:'macos'});assert.equal(collector.statusCode,200,collector.body);
 const collectorHeaders={authorization:'Bearer '+collector.json().token,'x-mote-ingress-version':'2'};
 const begin=(input:FileRevision,headers=collectorHeaders)=>request('POST','/api/file-sync/v1/uploads',input,headers);
 const upload=async(input:FileRevision,bytes:Buffer,headers=collectorHeaders)=>{
  const response=await begin(input,headers);assert.equal(response.statusCode,200,response.body);const session=response.json();if(session.ack)return session.ack;
  for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++){const chunk=bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES),received=await request('PUT',`/api/file-sync/v1/uploads/${session.uploadId}/parts/${part}`,chunk,headers);assert.equal(received.statusCode,200,received.body);assert.deepEqual(received.json(),{part,hash:sha256(chunk),bytes:chunk.length});}
  const committed=await request('POST',`/api/file-sync/v1/uploads/${session.uploadId}/commit`,{},headers);assert.equal(committed.statusCode,200,committed.body);const ack=committed.json();assert.equal(ack.receipt.state,'received');assert.equal(ack.sourceId,input.sourceId);assert.equal(ack.externalId,input.item.externalId);assert.equal(ack.revision,input.item.revision);assert.equal(ack.sha256,input.sha256);return ack;
 };
 return {directory,get node(){return node;},request,owner,collectorHeaders,begin,upload,cleanup,async restart(){await node.app.close();node=await start();origin=await node.app.listen({host:'127.0.0.1',port:0});}};
}
function manifest(bytes:Buffer,revision='v1',previousRevision:string|null=null,sourceId='visible',externalId='generated-report'):FileRevision{return {sourceId,previousRevision,item:{externalId,revision,observedAt:'2026-11-17T00:00:00Z',title:'Generated report.txt',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},relativePath:'generated/report.txt',sizeBytes:bytes.length,sha256:sha256(bytes)};}

test('owner HTTP archive deletion rejects old retries and still receives the next revision after restart',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated old report'),first=manifest(bytes),ack=await f.upload(first,bytes);
 assert.equal((await f.request('DELETE','/api/files/'+ack.id,undefined,f.collectorHeaders)).statusCode,403,'collectors cannot delete Central archives');
 const deleted=await f.request('DELETE','/api/files/'+ack.id);assert.equal(deleted.statusCode,200,deleted.body);assert.deepEqual(deleted.json(),{deleted:1});
 assert.equal((await f.request('GET','/api/files/'+ack.id+'/content')).statusCode,404);
 assert.equal((await f.begin(first)).statusCode,410,'an old queue cannot recreate its deleted revision');
 await f.restart();
 assert.equal((await f.begin(first)).statusCode,410,'the same immutable revision stays deleted across restart');
 const head=await f.request('GET','/api/file-sync/v1/head?sourceId=visible&externalId=generated-report',undefined,f.collectorHeaders);assert.equal(head.statusCode,200,head.body);assert.deepEqual(head.json(),{revision:'v1',forgotten:false});
 const next=Buffer.from('Generated next report'),received=await f.upload(manifest(next,'v2',head.json().revision),next);
 assert.notEqual(received.id,ack.id);assert.equal((await f.request('GET','/api/files/'+received.id+'/content')).body,next.toString());assert.equal((await f.begin(first)).statusCode,410);
});

test('history deletion preserves independent origins and differs from explicit forgetting and source disappearance',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated independently retained bytes'),first=await f.upload(manifest(bytes),bytes),second=await f.upload(manifest(bytes,'v2','v1'),bytes),other=await f.upload(manifest(bytes,'v1',null,'other'),bytes,f.owner);
 const missing=manifest(bytes,'source-missing','v2');delete missing.sha256;missing.item.deleted=true;
 assert.equal((await f.request('PUT','/api/file-sync/v1/revisions',missing,f.collectorHeaders)).statusCode,200);
 assert.equal((await f.request('GET','/api/files/'+first.id+'/content')).body,bytes.toString(),'source disappearance retains the authorized historical original');
 const removed=await f.request('DELETE','/api/files/'+second.id);assert.equal(removed.statusCode,200,removed.body);assert.deepEqual(removed.json(),{deleted:3});
 assert.equal((await f.request('GET','/api/files/'+other.id+'/content')).body,bytes.toString());assert.equal(f.node.store.assets.retained(sha256(bytes)),true,'the independent source still owns the deduplicated bytes');
 for(const input of [manifest(bytes),manifest(bytes,'v2','v1')])assert.equal((await f.begin(input)).statusCode,410);
 const next=await f.upload(manifest(bytes,'v3','source-missing'),bytes);assert.notEqual(next.id,first.id);
 f.node.files.remove(next.id);assert.deepEqual(f.node.files.syncHead('visible','generated-report'),{revision:'v3',forgotten:false});
 const afterRemove=await f.upload(manifest(bytes,'v4','v3'),bytes);f.node.files.forget(afterRemove.id);
 assert.deepEqual(f.node.files.syncHead('visible','generated-report'),{revision:'v4',forgotten:true});
 assert.equal((await f.begin(manifest(bytes,'v5','v4'))).statusCode,410,'explicit forget retains its stronger future suppression');
 const allowed=await f.request('POST','/api/files/'+afterRemove.id+'/allow-again',{sourceId:'visible',externalId:'generated-report'});assert.equal(allowed.statusCode,200,allowed.body);
 assert.equal((await f.begin(manifest(bytes,'v4','v3'))).statusCode,410,'allow-again never restores a deleted immutable revision');
 await f.upload(manifest(bytes,'v5','v4'),bytes);
});

test('archive deletion fences an already written upload before its late commit and retires only admitted revisions',async t=>{
 const f=await fixture(t),firstBytes=Buffer.from('Generated original before delete'),first=await f.upload(manifest(firstBytes),firstBytes),pendingBytes=Buffer.from('Generated admitted version before delete'),input=manifest(pendingBytes,'v2','v1');
 const begun=await f.begin(input);assert.equal(begun.statusCode,200,begun.body);const id=begun.json().uploadId;
 assert.equal((await f.request('PUT','/api/file-sync/v1/uploads/'+id+'/parts/0',pendingBytes,f.collectorHeaders)).statusCode,200);
 let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve),put=f.node.store.assets.putUpload.bind(f.node.store.assets);
 f.node.store.assets.putUpload=async(...args)=>{const result=await put(...args);entered();await gate;return result;};
 const cleanup=()=>{f.node.store.assets.putUpload=put;release();};f.cleanup.add(cleanup);
 const committing=f.request('POST','/api/file-sync/v1/uploads/'+id+'/commit',{},f.collectorHeaders);
 await Promise.race([ready,committing.then(response=>{throw Error('Commit did not reach the controlled publish gate: '+response.body);})]);
 const deleted=await f.request('DELETE','/api/files/'+first.id);assert.equal(deleted.statusCode,200,deleted.body);cleanup();f.cleanup.delete(cleanup);
 assert.ok([404,410].includes((await committing).statusCode),'the late commit cannot publish an ACK or restore evidence');
 assert.equal((await f.begin(input)).statusCode,410);assert.equal(f.node.sources.getItem('visible','generated-report'),undefined);
 await f.restart();assert.equal((await f.begin(input)).statusCode,410,'the previously uncommitted revision is also durably withdrawn');
 const current=Buffer.from('Generated new version after history deletion');await f.upload(manifest(current,'v3','v1'),current);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);
});

test('queued metadata and manifest batches cannot publish a revision after owner history deletion',async t=>{
 const f=await fixture(t);
 for(const batch of [false,true]){
  const key=batch?'generated-batch':'generated-metadata',bytes=Buffer.from('Generated '+key),first=await f.upload(manifest(bytes,'v1',null,'visible',key),bytes),input=manifest(Buffer.alloc(0),'v2','v1','visible',key);input.item.layer='reference';delete input.sha256;
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);
  const lock=f.node.files.serialize('item:visible:'+key,async()=>{entered();await gate;});await ready;
  let admitted!:()=>void;const arrival=new Promise<void>(resolve=>admitted=resolve),files=f.node.files;
  const original=batch?files.manifestBatch.bind(files):files.revision.bind(files);
  if(batch)files.manifestBatch=(...args)=>{const result=(original as typeof files.manifestBatch)(...args);admitted();return result;};
  else files.revision=(...args)=>{const result=(original as typeof files.revision)(...args);admitted();return result;};
  const cleanup=()=>{if(batch)files.manifestBatch=original as typeof files.manifestBatch;else files.revision=original as typeof files.revision;release();};f.cleanup.add(cleanup);
  const writing=f.request(batch?'POST':'PUT',batch?'/api/file-sync/v1/manifests':'/api/file-sync/v1/revisions',batch?{items:[input]}:input,f.collectorHeaders);
  await Promise.race([arrival,writing.then(response=>{throw Error('Metadata did not reach its admission: '+response.body);})]);
  const deleted=await f.request('DELETE','/api/files/'+first.id);assert.equal(deleted.statusCode,200,deleted.body);cleanup();f.cleanup.delete(cleanup);await lock;
  const response=await writing;if(batch){assert.equal(response.statusCode,200,response.body);assert.equal(response.json().results[0].status,410);}else assert.equal(response.statusCode,410,response.body);
  const repeated=await f.request('PUT','/api/file-sync/v1/revisions',input,f.collectorHeaders);assert.equal(repeated.statusCode,410,repeated.body);
  await f.upload(manifest(bytes,'v3','v1','visible',key),bytes);
 }
});

test('source scope generations fence partial uploads across restart and an ABA policy change without discarding input',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated partial upload retained across scope changes'),input=manifest(bytes),begun=await f.begin(input);assert.equal(begun.statusCode,200,begun.body);const old=begun.json().uploadId;
 assert.equal((await f.request('PUT','/api/file-sync/v1/uploads/'+old+'/parts/0',bytes,f.collectorHeaders)).statusCode,200);
 const patch=await f.request('PATCH','/api/sources/visible',{initialSync:'new_only'});assert.equal(patch.statusCode,200,patch.body);assert.equal(patch.json().syncScopeVersion,1);
 for(const [method,suffix,payload]of [['GET','',undefined],['PUT','/parts/0',bytes],['POST','/commit',{}]] as const)assert.equal((await f.request(method,'/api/file-sync/v1/uploads/'+old+suffix,payload,f.collectorHeaders)).statusCode,409);
 await f.restart();assert.equal((await f.request('GET','/api/file-sync/v1/uploads/'+old,undefined,f.collectorHeaders)).statusCode,409);
 const restored=await f.request('PATCH','/api/sources/visible',{initialSync:'all'});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().syncScopeVersion,2);
 assert.equal((await f.request('POST','/api/file-sync/v1/uploads/'+old+'/commit',{},f.collectorHeaders)).statusCode,409,'returning to the old policy does not revive the old grant');
 assert.deepEqual(f.node.store.contentEncryption.read(join(f.node.files.uploads,old,'0')),bytes,'revoked but unrecoverable input is retained');
 const fresh=await f.begin(input);assert.equal(fresh.statusCode,200,fresh.body);assert.notEqual(fresh.json().uploadId,old);assert.deepEqual(fresh.json().parts,[],'current authorization creates a fresh admission identity');
 await f.upload(input,bytes);assert.equal((await f.request('GET','/api/file-sync/v1/uploads/'+old,undefined,f.collectorHeaders)).statusCode,409);
});

test('an upload without an authority pin is never promoted to current and new admissions publish both records atomically',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated legacy unpinned pending input'),input=manifest(bytes),begun=await f.begin(input);assert.equal(begun.statusCode,200,begun.body);const old=begun.json().uploadId,db=f.node.store.db;
 assert.equal((await f.request('PUT','/api/file-sync/v1/uploads/'+old+'/parts/0',bytes,f.collectorHeaders)).statusCode,200);
 db.prepare('DELETE FROM file_upload_scopes WHERE upload_id=?').run(old);db.prepare('UPDATE file_uploads SET fingerprint=? WHERE id=?').run(sha256(String(db.prepare('SELECT manifest FROM file_uploads WHERE id=?').get(old)!.manifest)),old);
 await f.restart();const denied=await f.request('GET','/api/file-sync/v1/uploads/'+old,undefined,f.collectorHeaders);assert.equal(denied.statusCode,409,denied.body);assert.equal(denied.json().error,'conflict');assert.throws(()=>f.node.files.session(old,()=>{}),/authorization is unavailable/);assert.deepEqual(f.node.store.contentEncryption.read(join(f.node.files.uploads,old,'0')),bytes);
 const fresh=await f.begin(input);assert.equal(fresh.statusCode,200,fresh.body);assert.notEqual(fresh.json().uploadId,old);assert.deepEqual(fresh.json().parts,[]);assert.equal((await f.request('GET','/api/file-sync/v1/uploads/'+old,undefined,f.collectorHeaders)).statusCode,409);
 const current=f.node.store.db,count=current.prepare('SELECT count(*) n FROM file_uploads').get()!.n;
 current.exec("CREATE TRIGGER generated_pin_failure BEFORE INSERT ON file_upload_scopes BEGIN SELECT RAISE(ABORT,'generated pin failure'); END");
 const failed=await f.begin(manifest(bytes,'another',null,'visible','generated-atomic'));assert.equal(failed.statusCode,500,failed.body);
 current.exec('DROP TRIGGER generated_pin_failure');assert.equal(current.prepare('SELECT count(*) n FROM file_uploads').get()!.n,count);assert.equal(current.prepare('SELECT count(*) n FROM file_upload_scopes WHERE upload_id NOT IN (SELECT id FROM file_uploads)').get()!.n,0);
});

test('a scope reset while original publication awaits blocks the old admission before actual commit',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated input waiting across a source reset'),input=manifest(bytes),begun=await f.begin(input);assert.equal(begun.statusCode,200,begun.body);const id=begun.json().uploadId;
 assert.equal((await f.request('PUT','/api/file-sync/v1/uploads/'+id+'/parts/0',bytes,f.collectorHeaders)).statusCode,200);
 let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve),put=f.node.store.assets.putUpload.bind(f.node.store.assets);
 f.node.store.assets.putUpload=async(...args)=>{const result=await put(...args);entered();await gate;return result;};
 const cleanup=()=>{f.node.store.assets.putUpload=put;release();};f.cleanup.add(cleanup);
 const committing=f.request('POST','/api/file-sync/v1/uploads/'+id+'/commit',{},f.collectorHeaders);await Promise.race([ready,committing.then(response=>{throw Error('Commit did not reach its scope gate: '+response.body);})]);
 f.node.sources.resetCoverage('visible');cleanup();f.cleanup.delete(cleanup);const response=await committing;assert.equal(response.statusCode,409,response.body);
 assert.equal(f.node.sources.getItem('visible','generated-report'),undefined);assert.deepEqual(f.node.store.contentEncryption.read(join(f.node.files.uploads,id,'0')),bytes);
 const fresh=await f.begin(input);assert.equal(fresh.statusCode,200,fresh.body);assert.notEqual(fresh.json().uploadId,id);await f.upload(input,bytes);
});

test('a production Desktop queue restored after a lost ACK cannot replay deleted history and uses the real head for its first new version',async t=>{
 const f=await fixture(t),path=join(f.directory,'generated-source.json'),source:SourceDefinition={id:'visible',name:'Generated visible',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'archive',enabled:true};
 const bytes=Buffer.from('Generated old backup report'),scanned=(body:Buffer):ScannedItem=>({externalId:'generated-report',title:'Generated report.txt',text:'',kind:'file',layer:'original',mimeType:'text/plain',deleted:false,localOriginalBase64:body.toString('base64'),document:{fileIndex:{version:1,fileId:'generated-report',contentVersion:sha256(body),mode:'archive',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,allowRead:false}}});
 const attempted:string[]=[],predecessors:(string|null)[]=[];let lose=true;
 const request:SourceRequest=async(url,payload,method)=>{
  attempted.push(url);if(url==='/api/file-sync/v1/uploads')predecessors.push((payload as FileRevision).previousRevision);
  const response=await f.request(method,url,payload,f.collectorHeaders);if(response.statusCode>=400)throw Object.assign(Error('Generated HTTP '+response.statusCode),{httpStatus:response.statusCode});
  if(lose&&url.endsWith('/commit')){lose=false;throw Error('Generated lost final ACK');}return response.json();
 };
 const original=new SourceSync(path);await original.initialize();await original.stage({items:[scanned(bytes)],seen:['generated-report'],skipped:0,complete:true},false,'2026-11-16T00:00:00Z');
 await assert.rejects(original.flush(source,request),/lost final ACK/);assert.equal(original.status().pending,1);
 const first=f.node.sources.getItem('visible','generated-report')!;assert.ok(first);assert.equal((await f.request('DELETE','/api/files/'+first.captureId)).statusCode,200);await f.restart();
 const restored=new SourceSync(path);await restored.initialize();await restored.flush(source,request);assert.equal(restored.status().pending,0);assert.deepEqual(restored.status().failures.map(value=>value.status),[410]);
 const retained=sourceState(path) as {quarantined?:Record<string,{item:{localOriginalBase64?:string}}>};assert.ok(Object.values(retained.quarantined??{}).some(value=>value.item.localOriginalBase64===bytes.toString('base64')),'the rejected old queue input remains retained rather than acknowledged or erased');
 const next=Buffer.from('Generated new backup report');await restored.stage({items:[scanned(next)],seen:['generated-report'],skipped:0,complete:true},false,'2026-11-17T00:00:00Z');const start=attempted.length;await restored.flush(source,request);
 assert.ok(attempted.slice(start).some(path=>path.startsWith('/api/file-sync/v1/head?')),'a client without a successful prior ACK consumes the actual head');assert.equal(predecessors.at(-1),first.revision);assert.equal(restored.status().pending,0);
 const current=f.node.sources.getItem('visible','generated-report')!;assert.notEqual(current.captureId,first.captureId);assert.equal((await f.request('GET','/api/files/'+current.captureId+'/content')).body,next.toString());assert.equal((await f.begin(manifest(bytes,first.revision))).statusCode,410);
});

test('a null predecessor only resumes centrally deleted history and preserves its immutable manifest on retry',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated history before a fresh producer'),first=await f.upload(manifest(bytes),bytes),reference=manifest(Buffer.alloc(0),'fresh',null);reference.item.layer='reference';delete reference.sha256;
 assert.equal((await f.request('PUT','/api/file-sync/v1/revisions',reference,f.collectorHeaders)).statusCode,409,'null cannot reset an ordinary live head');
 assert.equal((await f.request('DELETE','/api/files/'+first.id)).statusCode,200);
 assert.equal((await f.request('PUT','/api/file-sync/v1/revisions',{...reference,previousRevision:'wrong'},f.collectorHeaders)).statusCode,409,'deletion does not excuse a wrong non-null predecessor');
 const accepted=await f.request('PUT','/api/file-sync/v1/revisions',reference,f.collectorHeaders);assert.equal(accepted.statusCode,200,accepted.body);
 assert.equal(JSON.parse(f.node.files.version(accepted.json().id).manifest).previousRevision,null,'normalization never rewrites the producer manifest');
 const repeated=await f.request('PUT','/api/file-sync/v1/revisions',reference,f.collectorHeaders);assert.equal(repeated.statusCode,200,repeated.body);assert.equal(repeated.json().id,accepted.json().id);assert.equal(repeated.json().duplicate,true);
 assert.equal((await f.request('PUT','/api/file-sync/v1/revisions',{...reference,item:{...reference.item,revision:'another'}},f.collectorHeaders)).statusCode,409,'the new live head closes the null-only recovery window');
});

test('a competing real source head cannot be overwritten after a null-history admission awaits publication',async t=>{
 const f=await fixture(t),bytes=Buffer.from('Generated deleted predecessor'),first=await f.upload(manifest(bytes),bytes);assert.equal((await f.request('DELETE','/api/files/'+first.id)).statusCode,200);
 const incoming=manifest(Buffer.alloc(0),'waiting',null);incoming.item.layer='reference';delete incoming.sha256;
 let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve),upsert=f.node.sources.upsert.bind(f.node.sources);
 f.node.sources.upsert=async(...args)=>{if((args[1] as {revision?:string}).revision==='waiting'){entered();await gate;}return upsert(...args);};
 const cleanup=()=>{f.node.sources.upsert=upsert;release();};f.cleanup.add(cleanup);
 const writing=f.request('PUT','/api/file-sync/v1/revisions',incoming,f.collectorHeaders);await Promise.race([ready,writing.then(response=>{throw Error('Write did not reach its predecessor gate: '+response.body);})]);
 const concurrent=await f.request('PUT','/api/sources/visible/items',{...incoming.item,revision:'concurrent',observedAt:'2026-11-17T01:00:00Z'},f.collectorHeaders);assert.equal(concurrent.statusCode,200,concurrent.body);
 cleanup();f.cleanup.delete(cleanup);const refused=await writing;assert.equal(refused.statusCode,409,refused.body);assert.equal(f.node.files.syncHead('visible','generated-report').revision,'concurrent');assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM source_versions WHERE source_id='visible' AND revision='waiting'").get()!.n,0);
});

test('a failed owner deletion rolls back pending revision withdrawal and keeps its original admission recoverable',async t=>{
 const f=await fixture(t),firstBytes=Buffer.from('Generated archived original for rollback'),first=await f.upload(manifest(firstBytes),firstBytes),bytes=Buffer.from('Generated pending original for rollback'),input=manifest(bytes,'v2','v1'),begun=await f.begin(input);assert.equal(begun.statusCode,200,begun.body);const id=begun.json().uploadId;
 assert.equal((await f.request('PUT','/api/file-sync/v1/uploads/'+id+'/parts/0',bytes,f.collectorHeaders)).statusCode,200);
 const db=f.node.store.db,snapshot=()=>Object.fromEntries(['captures','source_versions','file_uploads','file_upload_scopes','file_parts','changes'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),before=snapshot();
 db.exec(`CREATE TEMP TRIGGER generated_archive_failure BEFORE DELETE ON captures WHEN OLD.id='${first.id}' BEGIN SELECT RAISE(ABORT,'generated archive failure'); END`);
 const failed=await f.request('DELETE','/api/files/'+first.id);assert.equal(failed.statusCode,500,failed.body);assert.deepEqual(snapshot(),before);assert.deepEqual(f.node.store.contentEncryption.read(join(f.node.files.uploads,id,'0')),bytes);
 db.exec('DROP TRIGGER generated_archive_failure');const committed=await f.request('POST','/api/file-sync/v1/uploads/'+id+'/commit',{},f.collectorHeaders);assert.equal(committed.statusCode,200,committed.body);assert.equal(committed.json().revision,'v2');
 const deleted=await f.request('DELETE','/api/files/'+committed.json().id);assert.equal(deleted.statusCode,200,deleted.body);assert.deepEqual(deleted.json(),{deleted:2});assert.equal((await f.begin(input)).statusCode,410);
});
