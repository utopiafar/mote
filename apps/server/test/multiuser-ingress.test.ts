import {execFileSync} from 'node:child_process';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,symlinkSync,writeFileSync,readFileSync,realpathSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {FILE_PART_BYTES} from '@mote/shared';
import {buildApp} from '../src/app.js';
import {bytesHash,identityHash} from '../src/scope/originals.js';
import type {PrivateData} from '../src/scope/private-data.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {LifecycleAuthority} from '../src/scope/lifecycle.js';
import {openScopeStorage} from '../src/scope/storage.js';
const password='Generated-ingress-only-01';
const protocol={'x-mote-protocol-version':'2','x-mote-ingress-version':'3'};
const source=(id='same-source',retention='snapshot',deviceId='same-device')=>({id,name:'Generated source',kind:retention==='archive'?'coding-agent':'local-files',deviceId,platform:'import',retention});
const item=(externalId='same-external',text='Generated source item',revision='same-revision')=>({externalId,revision,observedAt:'2026-01-01T00:00:00Z',title:'Generated title',text,kind:'file',layer:'original'});
const capture=(id=randomUUID(),image?:Buffer)=>({id,deviceId:'same-device',deviceName:'Generated device',platform:'import',capturedAt:'2026-01-01T00:00:00Z',durationMs:0,source:'screen',ocrText:image?'':'Generated capture',...(image?{imageBase64:image.toString('base64'),imageMime:'image/png',ocr:{status:'pending'}}:{})});
const revision=(sourceId:string,bytes:Buffer,externalId='same-external')=>({sourceId,item:item(externalId,''),sizeBytes:bytes.length,sha256:bytesHash(bytes),relativePath:'generated.bin'});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(realpathSync(tmpdir()),'mote-m03-'));const preflight=openScopeStorage(directory),deploymentId=preflight.deploymentId;preflight.close();
 const grants=new Map<string,any>(),lifecycleAuthority=new LifecycleAuthority(deploymentId,{verify:async grant=>grants.get(grant),isCurrent:context=>grants.has(context.operationId)});
 const nodes:Awaited<ReturnType<typeof buildApp>>[]=[];let node=await buildApp({dataDir:directory},{lifecycleAuthority});nodes.push(node);
 t.after(async()=>{for(const current of nodes.reverse())await current.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.accounts!.initialize('generated-admin',password);
 const request=(token:string|undefined,url:string,method:any='GET',payload?:unknown,extra:Record<string,string>={})=>node.app.inject({method,url,headers:{...protocol,...(token?{authorization:'Bearer '+token}:{}),...extra},...(payload===undefined?{}:{payload})});
 const login=async(username:string)=>{const response=await request(undefined,'/api/auth/login','POST',{username,password,mode:'client'});assert.equal(response.statusCode,200,response.body);return response.json();};
 const admin=await login('generated-admin');
 const create=async(username:string)=>{const response=await request(admin.token,'/api/admin/accounts','POST',{username,password});assert.equal(response.statusCode,200,response.body);return response.json();};
 const a=await create('generated-a'),b=await create('generated-b'),alice=await login(a.username),bob=await login(b.username);
 const register=async(token:string,value=source())=>{const response=await request(token,'/api/ingress/sources','POST',value);assert.equal(response.statusCode,200,response.body);return response.json();};
 const intake=async(token:string,values:unknown[],id='same-batch',sourceId='same-source',kind='captures')=>{const response=await request(token,`/api/ingress/sources/${sourceId}/${kind}`,'POST',{batchId:id,items:values});assert.equal(response.statusCode,200,response.body);return response.json();};
 const service=async(token:string)=>node.ingress.forUser(await node.authority.authenticate(token));
 const begin=async(token:string,bytes:Buffer,batchId='same-key',sourceId='same-source',externalId='same-external')=>{const response=await request(token,`/api/ingress/sources/${sourceId}/uploads`,'POST',{batchId,revision:revision(sourceId,bytes,externalId)});assert.equal(response.statusCode,200,response.body);return response.json();};
 const part=async(token:string,id:string,bytes:Buffer,index=0)=>{const response=await request(token,`/api/ingress/uploads/${id}/parts/${index}`,'PUT',{bytes:bytes.toString('base64'),checksum:bytesHash(bytes)});assert.equal(response.statusCode,200,response.body);};
 const commit=async(token:string,id:string)=>{const response=await request(token,`/api/ingress/uploads/${id}/commit`,'POST',{});assert.equal(response.statusCode,200,response.body);return response.json();};
 const restart=async()=>{await node.app.close();node=await buildApp({dataDir:directory},{lifecycleAuthority});nodes.push(node);};
 return {get node(){return node;},directory,deploymentId,grants,lifecycleAuthority,request,admin,a,b,alice,bob,register,intake,service,begin,part,commit,restart};
}

test('real ingress binds equal device, UUID, batch and bytes to credentials; request selectors cannot change ownership',async t=>{
 const f=await fixture(t);for(const token of [f.alice.token,f.bob.token])await f.register(token);
 const bytes=Buffer.from('Generated image bytes'),input=capture(randomUUID(),bytes);
 const a=await f.intake(f.alice.token,[input]),b=await f.intake(f.bob.token,[input]);assert.notEqual(a.id,b.id);assert.equal(a.userId,f.a.userId);assert.equal(b.userId,f.b.userId);assert.notEqual(a.captures[0].original.ref,b.captures[0].original.ref);
 assert.deepEqual(await f.intake(f.alice.token,[input]),a);
 assert.equal((await f.request(f.alice.token,'/api/ingress/sources/same-source/captures','POST',{batchId:'spoof',items:[input],userId:f.b.userId})).statusCode,401);
 assert.equal((await f.request(f.alice.token,'/api/ingress/sources/same-source/captures','POST',{batchId:'nested',items:[{...capture(),userId:f.b.userId}]})).statusCode,400);
 assert.equal((await f.request(f.alice.token,'/api/ingress/sources/same-source/captures','POST',{batchId:'bad-version',items:[capture()]},{'x-mote-ingress-version':'2'})).statusCode,426);
 const record=await f.request(f.alice.token,'/api/captures/'+input.id);assert.equal(record.json().blobHash,bytesHash(bytes));assert.equal(record.json().indexingStatus,'pending');assert.ok(!record.body.includes(bytes.toString('base64')));
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));t.after(()=>db.close());assert.ok(!String(db.prepare('SELECT json FROM pd_captures WHERE user_id=?').get(f.a.userId)!.json).includes(bytes.toString('base64')));
});

test('file upload, immutable receipts, authenticated download/play ranges and tickets isolate A/B and administrator',async t=>{
 const f=await fixture(t);for(const token of [f.alice.token,f.bob.token])await f.register(token);
 const bytes=Buffer.from('Generated original retained file bytes'),a=await f.begin(f.alice.token,bytes),b=await f.begin(f.bob.token,bytes);assert.notEqual(a.id,b.id);
 for(const [token,upload] of [[f.alice.token,a],[f.bob.token,b]])await f.part(token,upload.id,bytes);
 const ar=await f.commit(f.alice.token,a.id),br=await f.commit(f.bob.token,b.id),ref=ar.captures[0].original.ref,bref=br.captures[0].original.ref;
 assert.deepEqual(await f.commit(f.alice.token,a.id),ar);assert.equal((await f.request(f.alice.token,'/api/ingress/uploads/'+b.id)).statusCode,404);
 const aid=ref.slice(9),bid=bref.slice(9),ticket=(await f.request(f.alice.token,`/api/ingress/originals/${aid}/tickets`,'POST',{mode:'play'})).json().ticket;
 const url=`/api/ingress/originals/${aid}/content?ticket=${encodeURIComponent(ticket)}`;
 assert.equal((await f.request(undefined,url)).statusCode,401);assert.equal((await f.request(f.bob.token,url)).statusCode,404);assert.equal((await f.request(f.admin.token,url)).statusCode,404);
 assert.equal((await f.request(f.alice.token,`/api/ingress/originals/${bid}/content?ticket=${ticket}`)).statusCode,404);
 const full=await f.request(f.alice.token,url);assert.equal(full.statusCode,200,full.body);assert.deepEqual(full.rawPayload,bytes);assert.equal(full.headers['content-disposition'],'attachment');
 const range=await f.request(f.alice.token,url,'GET',undefined,{range:'bytes=2-7'});assert.equal(range.statusCode,206);assert.deepEqual(range.rawPayload,bytes.subarray(2,8));
 const suffix=await f.request(f.alice.token,url,'GET',undefined,{range:'bytes=-5'});assert.deepEqual(suffix.rawPayload,bytes.subarray(-5));
 assert.equal((await f.request(f.alice.token,url+'x')).statusCode,404);
 const [body]=ticket.split('.'),expired=JSON.parse(Buffer.from(body,'base64url').toString());expired.expires=0;const expiredBody=Buffer.from(JSON.stringify(expired)).toString('base64url'),expiredTicket=expiredBody+'.'+createHmac('sha256',f.node.ingress.key).update(expiredBody).digest('base64url');assert.equal((await f.request(f.alice.token,`/api/ingress/originals/${aid}/content?ticket=${expiredTicket}`)).statusCode,404);
});

test('disconnect/restart resumes original parts and ownership; duplicate batches and late receipts cannot acknowledge B',async t=>{
 const f=await fixture(t);for(const token of [f.alice.token,f.bob.token])await f.register(token);
 const bytes=Buffer.alloc(FILE_PART_BYTES+137,7),upload=await f.begin(f.alice.token,bytes);await f.part(f.alice.token,upload.id,bytes.subarray(0,FILE_PART_BYTES));await f.restart();
 const resumed=await f.begin(f.alice.token,bytes);assert.equal(resumed.id,upload.id);assert.equal(resumed.parts.length,1);assert.equal(resumed.userId,f.a.userId);
 assert.equal((await f.request(f.bob.token,`/api/ingress/uploads/${upload.id}/parts/1`,'PUT',{bytes:'AA==',checksum:bytesHash(Buffer.from([0]))})).statusCode,404);
 await f.part(f.alice.token,upload.id,bytes.subarray(FILE_PART_BYTES),1);const receipt=await f.commit(f.alice.token,upload.id);await f.restart();
 assert.deepEqual((await f.request(f.alice.token,'/api/ingress/uploads/'+upload.id)).json(),receipt);assert.equal((await f.request(f.bob.token,'/api/ingress/uploads/'+upload.id)).statusCode,404);
 const other=await f.begin(f.bob.token,bytes);assert.notEqual(other.id,upload.id);assert.equal((await f.request(f.bob.token,'/api/ingress/uploads/'+other.id)).json().state,'pending');
 const changed=await f.request(f.alice.token,'/api/ingress/sources/same-source/uploads','POST',{batchId:'same-key',revision:revision('same-source',Buffer.from('changed'))});assert.equal(changed.statusCode,409);
});

test('source/Coding archive originals stay scoped and out of raw data search; restricted plugins cannot widen dependencies',async t=>{
 const f=await fixture(t);for(const token of [f.alice.token,f.bob.token]){await f.register(token,source('coding','archive'));await f.register(token,source('other'));}
 const input={...item('same-external','GENERATED_PRIVATE_CODING_TOOL_BODY'),kind:'message',document:{coding:{version:1,provider:'codex',sessionId:'same-session',projectKey:'same-project',eventId:'same-event',role:'tool_result',part:0,parts:1},timeBasis:'unknown',contentRole:'transcript'}};
 const ar=await f.intake(f.alice.token,[input],'same','coding','items'),br=await f.intake(f.bob.token,[input],'same','coding','items');assert.notEqual(ar.captures[0].original.ref,br.captures[0].original.ref);
 const context=await f.node.authority.authenticate(f.alice.token);let generation=true;const bound=f.node.ingress.bindSource(context,Object.freeze(['coding']),()=>{assert.ok(generation);});
 assert.equal(JSON.parse(bound.readOriginal(ar.captures[0].original.ref).bytes.toString()).text,input.text);assert.throws(()=>bound.readOriginal(br.captures[0].original.ref));assert.throws(()=>bound.receiveSourceItems('other','x',[item()]));
 assert.equal((await f.request(f.alice.token,'/api/data/search?query=GENERATED_PRIVATE_CODING_TOOL_BODY')).json().items.length,0);
 const other=await f.intake(f.alice.token,[item('other')],'other','other','items');
 const draft={id:'mat_'+identityHash(['coding','derived']),kind:'document',schemaVersion:1,title:'Generated projection',origin:{sourceId:'coding',externalId:'derived',deviceId:'same-device'},blocks:[{id:'text',kind:'text',format:'plain',text:'Generated published projection',memberIds:['capture']}],members:[{id:'capture',kind:'capture',ref:'capture:'+other.captures[0].id}],coverage:{state:'complete'},fidelity:{state:'derived',limitations:[]},retention:{original:'retained',policy:'keep'}};
 assert.throws(()=>bound.publishMaterial(draft));assert.equal((await f.request(f.alice.token,'/api/materials')).json().items.length,0);
 draft.members[0].ref='capture:'+ar.captures[0].id;assert.equal(bound.publishMaterial(draft).title,draft.title);
 generation=false;assert.throws(()=>bound.pageOriginals('coding'));assert.throws(()=>bound.publishMaterial(draft));
});

test('device and MCP credentials cannot upgrade source scope through private APIs, tickets or minting',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);await f.register(f.alice.token,source('other','snapshot','another-device'));
 const issued=await f.request(f.alice.token,'/api/login/session','POST',{serverUrl:'https://generated.invalid',deviceId:'same-device',deviceName:'Generated device',platform:'android'});assert.equal(issued.statusCode,200,issued.body);const token=issued.json().token;
 for(const [url,method,payload] of [['/api/sources','GET',undefined],['/api/data/search?query=x','GET',undefined],['/api/configuration','GET',undefined],['/api/login/ticket','POST',{}],['/api/login/session','POST',{serverUrl:'https://generated.invalid',deviceId:'another-device',deviceName:'bad',platform:'android'}],['/api/connections/mcp','POST',{access:'read',label:'upgrade'}]] as const)assert.equal((await f.request(token,url,method,payload)).statusCode,403,url);
 assert.equal((await f.request(token,'/api/ingress/sources/other/items','POST',{batchId:'x',items:[item()]})).statusCode,404);
 assert.equal((await f.request(token,'/api/ingress/sources','POST',source('wrong','snapshot','another-device'))).statusCode,403);
 await f.intake(token,[capture()]);
 const mcp=await f.request(f.alice.token,'/api/connections/mcp','POST',{access:'write',sourceIds:['same-source'],label:'Generated finite MCP'});assert.equal(mcp.statusCode,200,mcp.body);assert.equal((await f.request(mcp.json().token,'/api/ingress/sources/same-source/items','POST',{batchId:'mcp-upgrade',items:[item()]})).statusCode,401);
});

test('pin/GC and capture/source deletion affect only A even with identical bytes',async t=>{
 const f=await fixture(t);for(const token of [f.alice.token,f.bob.token])await f.register(token);
 const bytes=Buffer.from('Generated same original'),input=capture(randomUUID(),bytes),ar=await f.intake(f.alice.token,[input]),br=await f.intake(f.bob.token,[input]);
 const a=await f.service(f.alice.token),b=await f.service(f.bob.token),release=a.holdOriginal(ar.captures[0].original.ref);
 assert.equal((await f.request(f.alice.token,'/api/captures/'+input.id,'DELETE')).statusCode,200);assert.throws(()=>a.readOriginal(ar.captures[0].original.ref));assert.equal(a.gc().removed,0);release();assert.equal(a.gc().removed,1);assert.deepEqual(b.readOriginal(br.captures[0].original.ref).bytes,bytes);
 const next=capture(randomUUID(),bytes),receipt=await f.intake(f.alice.token,[next],'second');assert.equal((await f.request(f.alice.token,'/api/sources/same-source','DELETE')).statusCode,200);assert.equal((await f.request(f.alice.token,'/api/captures/'+next.id)).statusCode,404);assert.throws(()=>a.readOriginal(receipt.captures[0].original.ref));assert.equal(a.gc().removed,1);assert.deepEqual(b.readOriginal(br.captures[0].original.ref).bytes,bytes);
});

test('ordinary upload cannot import host paths; admin generated imports and symlink/traversal checks use real entry points',async t=>{
 const f=await fixture(t);await f.register(f.admin.token);await f.register(f.alice.token);const bytes=Buffer.from('Generated admin import'),path=join(f.directory,'generated.bin');writeFileSync(path,bytes);
 const payload={sourceId:'same-source',batchId:'generated-admin-import',path,revision:revision('same-source',bytes)};
 assert.equal((await f.request(f.alice.token,'/api/ingress/host-import','POST',payload)).statusCode,403);
 const imported=await f.request(f.admin.token,'/api/ingress/host-import','POST',payload);assert.equal(imported.statusCode,200,imported.body);assert.equal(imported.json().userId,f.admin.userId);
 const link=join(f.directory,'symlink.bin');symlinkSync(path,link);assert.equal((await f.request(f.admin.token,'/api/ingress/host-import','POST',{...payload,path:link,batchId:'symlink'})).statusCode,400);
 const traversal=await f.request(f.alice.token,'/api/ingress/sources/same-source/uploads','POST',{batchId:'traversal',revision:{...revision('same-source',bytes),relativePath:'../../host-secret'}});assert.equal(traversal.statusCode,400);
 const nested=join(f.directory,'nested');mkdirSync(nested);const nestedLink=join(f.directory,'linked-dir');symlinkSync(nested,nestedLink);writeFileSync(join(nested,'file.bin'),bytes);assert.equal((await f.request(f.admin.token,'/api/ingress/host-import','POST',{...payload,path:join(nestedLink,'file.bin'),batchId:'parent-symlink'})).statusCode,400);
});

test('original and workspace paths reject symbolic links, traversal and failed/revoked callbacks leave no temporary files',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);const bytes=Buffer.from('Generated symlink original'),receipt=await f.intake(f.alice.token,[capture(randomUUID(),bytes)]),service=await f.service(f.alice.token);
 const root=join(f.directory,'originals',identityHash([f.deploymentId,f.a.userId])),file=join(root,'objects',bytesHash(bytes),'0.plain'),outside=join(f.directory,'synthetic-outside');writeFileSync(outside,'DO_NOT_READ_SYNTHETIC_OUTSIDE');rmSync(file);symlinkSync(outside,file);assert.throws(()=>service.readOriginal(receipt.captures[0].original.ref));assert.equal(readFileSync(outside,'utf8'),'DO_NOT_READ_SYNTHETIC_OUTSIDE');
 await assert.rejects(service.withWorkspace(async work=>{assert.throws(()=>work.write('../escape',bytes));assert.throws(()=>work.write('/absolute',bytes));work.write('generated',bytes);assert.deepEqual(work.read('generated'),bytes);throw Error('Generated failed processing');}));assert.deepEqual(readdirSync(join(root,'work')),[]);
 const context=await f.node.authority.authenticate(f.alice.token);let current=true;const bound=f.node.ingress.bindSource(context,['same-source'],()=>{assert.ok(current);});await assert.rejects(bound.withWorkspace(async work=>{work.write('generated',bytes);current=false;return 'late';}));assert.deepEqual(readdirSync(join(root,'work')),[]);
});

test('failed batches roll back M02 and original links; a revoked asynchronous commit cannot publish a receipt',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);await f.register(f.bob.token);const first=capture(),second={...capture(),deviceId:'wrong-device'};
 assert.equal((await f.request(f.alice.token,'/api/ingress/sources/same-source/captures','POST',{batchId:'atomic',items:[first,second]})).statusCode,409);assert.equal((await f.request(f.alice.token,'/api/captures')).json().items.length,0);
 const bytes=Buffer.from('Generated revoked upload'),upload=await f.begin(f.alice.token,bytes);await f.part(f.alice.token,upload.id,bytes);const committing=f.request(f.alice.token,`/api/ingress/uploads/${upload.id}/commit`,'POST',{});
 await f.request(f.alice.token,'/api/auth/logout','POST',{});const result=await committing;assert.equal(result.statusCode,401,result.body);
 const relogin=await f.request(undefined,'/api/auth/login','POST',{username:'generated-a',password,mode:'client'}),token=relogin.json().token;assert.equal((await f.request(token,'/api/captures')).json().items.length,0);assert.equal((await f.request(token,'/api/ingress/uploads/'+upload.id)).json().state,'pending');
 const b=await f.intake(f.bob.token,[capture()]);assert.equal(b.userId,f.b.userId);
});

test('M05 durable attempt context fences retained ingress and source capabilities after cancellation',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);const entered=deferred(),held=deferred();let retained:any;
 f.node.execution!.register({kind:'generated.ingress',pool:'generated',concurrency:()=>1,policy:EXECUTION_POLICIES.deterministic,parseInput:()=>({}),execute:async run=>{retained=f.node.ingress.bindSource(run.context,['same-source'],()=>run.grant.assert());entered.resolve();await held.promise;return null;}});t.after(()=>held.resolve());
 const task=await f.request(f.alice.token,'/api/tasks','POST',{kind:'generated.ingress',operationId:'same-operation',input:{}});assert.equal(task.statusCode,200,task.body);await entered.promise;
 assert.equal((await f.request(f.alice.token,`/api/tasks/${task.json().id}/cancel`,'POST',{})).statusCode,200);assert.throws(()=>retained.receiveCaptures('same-source','late',[capture()]));held.resolve();assert.equal((await f.request(f.alice.token,'/api/captures')).json().items.length,0);
});

test('M16 lifecycle exports only own originals, validates before restore and reports unresolved physical erasure honestly',async t=>{
 const f=await fixture(t);for(const token of [f.alice.token,f.bob.token])await f.register(token);const bytes=Buffer.from('Generated lifecycle original'),input=capture(randomUUID(),bytes),a=await f.intake(f.alice.token,[input]),b=await f.intake(f.bob.token,[input]);
 const context=await f.node.authority.authenticate(f.alice.token),scope=f.node.services.forUser(context),archive=await scope.exportUser('ingress'),dataArchive=await scope.exportUser('private-data');assert.equal(JSON.stringify(archive).includes(f.b.userId),false);assert.equal((archive.payload as any).objects.length,1);
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));db.prepare('INSERT INTO ig_activity VALUES(?,?)').run(f.a.userId,'generated-unknown-child');const unknown=await scope.deleteUser('ingress','delete-a');assert.equal(unknown.status,'result_unknown');assert.throws(()=>(f.node.ingress.forUser(context)));assert.deepEqual((await f.service(f.bob.token)).readOriginal(b.captures[0].original.ref).bytes,bytes);
 f.grants.set('delete-control',{deploymentId:f.deploymentId,userId:f.a.userId,domain:'ingress',operationId:'delete-control',purpose:'delete'});const control=await f.lifecycleAuthority.authorize('delete-control');assert.throws(()=>f.node.ingress.pendingErasure(context));assert.deepEqual(f.node.ingress.pendingErasure(control),[{id:'generated-unknown-child',live:false}]);f.node.ingress.settleErasure(control,'generated-unknown-child','stopped');db.close();assert.equal((await scope.deleteUser('ingress','delete-a')).status,'complete');assert.equal((await scope.deleteUser('private-data','delete-a')).status,'complete');
 await scope.restoreUser('private-data',dataArchive,'restore-data');const corrupted=structuredClone(archive);(corrupted.payload as any).objects[0].bytes=Buffer.from('corrupt').toString('base64');await assert.rejects(scope.restoreUser('ingress',corrupted,'restore-bad'));
 await scope.restoreUser('ingress',archive,'restore-good');await scope.restoreUser('ingress',archive,'restore-good');assert.deepEqual((await f.service(f.alice.token)).readOriginal(a.captures[0].original.ref).bytes,bytes);
 assert.deepEqual((await f.service(f.bob.token)).readOriginal(b.captures[0].original.ref).bytes,bytes);
});

test('portable restore rejects same-user stitched source/original identities before creating objects',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);await f.register(f.alice.token,source('other'));const bytes=Buffer.from('Generated other-source original');await f.intake(f.alice.token,[capture(randomUUID(),bytes)],'other','other');
 const context=await f.node.authority.authenticate(f.alice.token),scope=f.node.services.forUser(context),archive=await scope.exportUser('ingress');await scope.deleteUser('ingress','delete-ingress');
 const forged=structuredClone(archive),row=(forged.payload as any).originals[0];row.source_id='same-source';row.id=identityHash([f.a.userId,row.source_id,row.capture_id,row.hash,row.mime,row.retention]);(forged.payload as any).scopes[0].source_id='same-source';await assert.rejects(scope.restoreUser('ingress',forged,'bad-stitch'));
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));assert.equal(db.prepare('SELECT count(*) n FROM ig_originals WHERE user_id=?').get(f.a.userId)!.n,0);db.close();await scope.restoreUser('ingress',archive,'original-restore');
 const limited=f.node.ingress.bindSource(context,['same-source'],()=>{});assert.throws(()=>limited.readOriginal('original:'+row.id));
});

test('failed object preparation does not poison a later capture of identical expected bytes',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);const bytes=Buffer.from('Generated immutable expected body'),wrong=Buffer.alloc(bytes.length,42),upload=await f.begin(f.alice.token,bytes);await f.part(f.alice.token,upload.id,wrong);
 assert.equal((await f.request(f.alice.token,`/api/ingress/uploads/${upload.id}/commit`,'POST',{})).statusCode,409);
 const receipt=await f.intake(f.alice.token,[capture(randomUUID(),bytes)],'after-failure');assert.deepEqual((await f.service(f.alice.token)).readOriginal(receipt.captures[0].original.ref).bytes,bytes);
 const root=join(f.directory,'originals',identityHash([f.deploymentId,f.a.userId]),'objects');assert.ok(readdirSync(root).every(name=>!name.endsWith('.tmp')));
});

test('raw capture source dependencies remain fenced through transitive Material publication and rebuild',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);await f.register(f.alice.token,source('other'));const receipt=await f.intake(f.alice.token,[capture()],'raw','other'),context=await f.node.authority.authenticate(f.alice.token),broad=f.node.ingress.bindSource(context,['same-source','other'],()=>{}),limited=f.node.ingress.bindSource(context,['same-source'],()=>{});
 const draft=(externalId:string,members:any[])=>({id:'mat_'+identityHash(['same-source',externalId]),kind:'document',schemaVersion:1,title:'Generated composite',origin:{sourceId:'same-source',externalId,deviceId:'same-device'},blocks:[{id:'text',kind:'text',format:'plain',text:'Generated transformed text',memberIds:members.map(member=>member.id)}],members,coverage:{state:'complete'},fidelity:{state:'derived',limitations:[]},retention:{original:'retained',policy:'keep'}});
 const material=broad.publishMaterial(draft('first',[{id:'raw',kind:'capture',ref:'capture:'+receipt.captures[0].id}]));assert.throws(()=>limited.publishMaterial(draft('second',[{id:'material',kind:'material',ref:material.ref}])));
 const update=await f.request(f.alice.token,'/api/sources/other/context','PATCH',{expectedVersion:0,description:'Generated source correction'});assert.equal(update.statusCode,200,update.body);
 const data=f.node.services.forUser(context).get<PrivateData>('private-data'),current=data.material(material.id);assert.throws(()=>limited.publishMaterial(draft('second',[{id:'material',kind:'material',ref:current.ref}])));
 const archive=await f.node.services.forUser(context).exportUser('private-data');assert.ok((archive.payload as any).material_sources.some((row:any)=>row.source_id==='other'));
});

test('domain deletion cannot report physical success while a workspace is live, and lifecycle cannot settle that live activity',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);const context=await f.node.authority.authenticate(f.alice.token),service=f.node.ingress.forUser(context),entered=deferred(),held=deferred(),working=service.withWorkspace(async work=>{work.write('generated',Buffer.from('Generated in-flight workspace'));entered.resolve();await held.promise;return true;});const rejection=assert.rejects(working);t.after(()=>held.resolve());await entered.promise;
 const deletion=await f.node.services.forUser(context).deleteUser('ingress','active-delete');assert.equal(deletion.status,'result_unknown');
 f.grants.set('active-control',{deploymentId:f.deploymentId,userId:f.a.userId,domain:'ingress',operationId:'active-control',purpose:'delete'});const control=await f.lifecycleAuthority.authorize('active-control'),pending=f.node.ingress.pendingErasure(control);assert.equal(pending.length,1);assert.equal(pending[0].live,true);assert.throws(()=>f.node.ingress.settleErasure(control,pending[0].id,'stopped'));
 held.resolve();await rejection;assert.deepEqual(f.node.ingress.pendingErasure(control),[]);assert.equal((await f.node.services.forLifecycle(control).run() as any).status,'complete');
});

test('FIFO originals and administrator imports fail without blocking a real isolated production host',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);await f.register(f.admin.token);const bytes=Buffer.from('Generated FIFO fixture'),receipt=await f.intake(f.alice.token,[capture(randomUUID(),bytes)]),file=join(f.directory,'originals',identityHash([f.deploymentId,f.a.userId]),'objects',bytesHash(bytes),'0.plain');rmSync(file);execFileSync('mkfifo',[file]);
 const code=`import {buildApp} from ${JSON.stringify(new URL('../src/app.ts',import.meta.url).href)};const node=await buildApp({dataDir:${JSON.stringify(f.directory)}});try{const context=await node.authority.authenticate(${JSON.stringify(f.alice.token)});let denied=false;try{node.ingress.forUser(context).readOriginal(${JSON.stringify(receipt.captures[0].original.ref)});}catch{denied=true;}if(!denied)throw Error('FIFO original accepted');const response=await node.app.inject({method:'POST',url:'/api/ingress/host-import',headers:{'x-mote-protocol-version':'2','x-mote-ingress-version':'3',authorization:'Bearer '+${JSON.stringify(f.admin.token)}},payload:${JSON.stringify({sourceId:'same-source',batchId:'fifo',path:file,revision:revision('same-source',bytes)})}});if(response.statusCode!==400)throw Error('FIFO import not rejected: '+response.statusCode);process.stdout.write('FIFO rejected without blocking');}finally{await node.app.close();}`;
 const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});assert.match(result,/FIFO rejected without blocking/);
});

test('revocation between preparation directory creation and pin admission removes the uncommitted temporary directory',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);const bytes=Buffer.from('Generated preparation admission fence'),upload=await f.begin(f.alice.token,bytes);await f.part(f.alice.token,upload.id,bytes);
 const root=join(f.directory,'originals',identityHash([f.deploymentId,f.a.userId]),'objects'),context=await f.node.authority.authenticate(f.alice.token),service=f.node.ingress.forUser(context,undefined,()=>{let names:string[]=[];try{names=readdirSync(root);}catch{}if(names.some(name=>name.endsWith('.tmp')))throw Error('Generated revoked preparation admission');});
 await assert.rejects(service.commitUpload(upload.id));assert.ok(readdirSync(root).every(name=>!name.endsWith('.tmp')));
});

test('workspace admission failure cleans its directory and owner GC removes crash staging only after I/O is quiescent',async t=>{
 const f=await fixture(t);await f.register(f.alice.token);const context=await f.node.authority.authenticate(f.alice.token),root=join(f.directory,'originals',identityHash([f.deploymentId,f.a.userId])),workRoot=join(root,'work');let invoked=false;
 const revoked=f.node.ingress.forUser(context,undefined,()=>{let names:string[]=[];try{names=readdirSync(workRoot);}catch{}if(names.length)throw Error('Generated revoked workspace admission');});
 await assert.rejects(revoked.withWorkspace(async()=>{invoked=true;}));assert.equal(invoked,false);assert.deepEqual(readdirSync(workRoot),[]);
 const objects=join(root,'objects');mkdirSync(objects,{recursive:true});const staging=join(objects,bytesHash(Buffer.from('Generated crash staging'))+'.'+randomUUID()+'.tmp');mkdirSync(staging);writeFileSync(join(staging,'0.plain'),'Generated uncommitted bytes');(await f.service(f.alice.token)).gc();assert.ok(!readdirSync(objects).some(name=>name.endsWith('.tmp')));
});
