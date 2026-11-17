import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest,type ClientRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {FILE_PART_BYTES,FILE_PART_RECEIPTS,filePartReceipts,type FilePartPage,type FileRevision} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {LocalRateLimit,LocalRateLimitError} from '../src/local-rate-limits.js';
import {sha256} from '../src/store.js';
import {SourceSync} from '../../desktop/src/source-sync.js';
import type {ScannedItem,SourceDefinition,SourceRequest} from '../../desktop/src/source-types.js';

const PART=FILE_PART_BYTES,owner='generated-local-rate-owner-credential',sourceId='generated-rate-source';
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-local-rate-'));
  let now=Date.now(),modelCalls=0;
  t.mock.method(Date,'now',()=>now);
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,profile:'test',maxExportBytes:1024*1024,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const boot=()=>buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{modelCalls++;throw Error('No model in local HTTP admission tests');},close:async()=>{}}});
  let node=await boot(),origin='';
  const listen=async()=>{origin=await node.app.listen({host:'127.0.0.1',port:0});};
  const headers=(token=owner)=>({authorization:'Bearer '+token,'x-mote-ingress-version':'2'});
  const call=async(path:string,method='GET',body?:unknown,token:string|null=owner,extra:Record<string,string>={})=>{
    const response=await fetch(origin+path,{method,headers:{...(token===null?{}:headers(token)),...(body===undefined?{}:{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}),...extra},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});
    const text=await response.text();return {status:response.status,headers:response.headers,body:JSON.parse(text),text};
  };
  t.after(async()=>{await node.app.close();assert.equal(modelCalls,0);await rm(directory,{recursive:true,force:true});});
  const revision=(id=String(randomUUID()),size=PART+17):FileRevision=>({sourceId,previousRevision:null,item:{externalId:id,revision:'v1',observedAt:new Date().toISOString(),kind:'file',layer:'original',title:'Generated admission file',text:'',mimeType:'application/octet-stream',deleted:false},sha256:'a'.repeat(64),sizeBytes:size,relativePath:'generated.bin'});
  return {directory,get node(){return node;},get origin(){return origin;},headers,call,revision,listen,advance:(ms:number)=>{now+=ms;},
    async source(){const result=await call('/api/sources','POST',{id:sourceId,deviceId:'generated-rate-device',name:'Generated rate source',kind:'local-files',platform:'macos',retention:'archive',enabled:true});assert.equal(result.status,200,result.text);},
    async restart(){await node.app.close();node=await boot();await listen();},
    async session(deviceId:string){const response=await call('/api/login/session','POST',{serverUrl:origin,deviceId,deviceName:deviceId,platform:'other',durationMs:86400000});assert.equal(response.status,200,response.text);return response.body.token as string;},
  };
}
function limited(response:{status:number;headers:Headers;body:Record<string,unknown>},retry='60'){
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),retry);assert.equal(response.body.error,'rate_limited');
}

test('login failures have a real HTTP 429 window, cannot forge a proxy identity, and never reach the session producer',async t=>{
  const f=await fixture(t);await f.listen();
  let sessions=0;const session=f.node.connections.session.bind(f.node.connections);
  t.mock.method(f.node.connections,'session',(...args:Parameters<typeof session>)=>{sessions++;return session(...args);});
  const body={serverUrl:f.origin,deviceId:'generated-browser',deviceName:'Generated browser',platform:'other',durationMs:86400000};
  for(let i=0;i<10;i++)assert.equal((await f.call('/api/login/session','POST',body,'invalid-'+i)).status,401);
  limited(await f.call('/api/login/session','POST',body,'another-invalid',{'x-forwarded-for':'192.0.2.10',forwarded:'for=192.0.2.11'}));
  assert.equal(sessions,0,'neither ordinary failures nor over-limit failures enter durable session issuance');
  assert.equal((await f.call('/api/login/session','POST',body)).status,200);assert.equal(sessions,1);
  for(let i=0;i<129;i++)assert.equal((await f.call('/api/connections/self')).status,200,'ordinary owner reads have no global request quota');
  for(let i=0;i<10;i++)assert.equal((await f.call('/api/login/exchange','POST',{code:'a'.repeat(43)},null)).status,410);
  limited(await f.call('/api/login/exchange','POST',{code:'a'.repeat(43)},null,{'x-forwarded-for':'192.0.2.99'}));
  const otherIp=await f.node.app.inject({method:'POST',url:'/api/login/exchange',remoteAddress:'192.0.2.20',payload:{code:'a'.repeat(43)}});
  assert.equal(otherIp.statusCode,410,'Fastify remote identity remains separate');
  for(let i=0;i<10;i++)assert.equal((await f.call('/api/connections/redeem','POST',{code:'a'.repeat(43),deviceId:'generated-phone',deviceName:'Generated phone',platform:'android'},null)).status,410,'pairing has its own bucket');
  limited(await f.call('/api/connections/redeem','POST',{},null));
  f.advance(59_999);limited(await f.call('/api/login/exchange','POST',{code:'a'.repeat(43)},null),'1');
  f.advance(1);assert.equal((await f.call('/api/login/exchange','POST',{code:'a'.repeat(43)},null)).status,410);
  assert.equal((await f.call('/api/login/session','POST',body,'invalid-after-recovery')).status,401);assert.equal(sessions,1);
});

test('verified owner credentials and PKCE handoffs have independent budgets; polling does not spend creation or ACK allowance',async t=>{
  const f=await fixture(t);await f.listen();
  const a=await f.session('generated-owner-a'),b=await f.session('generated-owner-b');
  for(let i=0;i<10;i++)assert.equal((await f.call('/api/login/ticket','POST',{},a)).status,200);
  limited(await f.call('/api/login/ticket','POST',{},a));
  assert.equal((await f.call('/api/login/ticket','POST',{},b)).status,200);assert.equal((await f.call('/api/login/ticket','POST',{})).status,200);
  const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('hex');
  const create=async(deviceId:string)=>f.call('/api/login/requests','POST',{serverUrl:f.origin,deviceId,deviceName:deviceId,platform:'other',challenge},null);
  const first=await create('generated-handoff-a'),second=await create('generated-handoff-b');assert.equal(first.status,200);assert.equal(second.status,200);
  const poll=(id:string,proof=verifier)=>f.call('/api/login/poll','POST',{id,verifier:proof},null);
  for(let i=0;i<60;i++){const response=await poll(first.body.id);assert.equal(response.status,200);assert.deepEqual(response.body,{ready:false});}
  limited(await poll(first.body.id));assert.equal((await poll(second.body.id)).status,200);
  for(let i=0;i<10;i++)assert.equal((await poll(second.body.id,'x'.repeat(43))).status,401);
  limited(await poll(second.body.id,'y'.repeat(43)));
  assert.equal((await poll(second.body.id)).status,200,'failed proofs cannot poison a valid proof on the same source address');
  const approval=await f.call('/api/login/requests/'+first.body.id+'/approve','POST',{});assert.equal(approval.status,200,approval.text);
  assert.equal((await f.call('/api/login/ack','POST',{id:first.body.id,verifier},null)).status,200);
  for(let i=2;i<10;i++)assert.equal((await create('generated-handoff-'+i)).status,200);
  limited(await create('generated-handoff-excess'));
  f.advance(60_000);assert.equal((await create('generated-handoff-recovered')).status,200);assert.equal((await poll(second.body.id)).status,200);
});

test('both actual upload producers charge only new multi-part admissions and preserve identity, entrypoint and window isolation',async t=>{
  const f=await fixture(t);await f.listen();await f.source();const second=await f.session('generated-upload-owner-b');
  const importManifest={id:randomUUID(),name:'generated-retained.bin',sizeBytes:PART+17};
  const fileManifest=f.revision();
  for(let i=0;i<120;i++){
    const imported=await f.call('/api/import-uploads','POST',i===0?importManifest:{name:'generated-'+i+'.bin',sizeBytes:PART+17});assert.equal(imported.status,200,imported.text);
    const synced=await f.call('/api/file-sync/v1/uploads','POST',i===0?fileManifest:f.revision());assert.equal(synced.status,200,synced.text);
  }
  const filesBefore=f.node.store.db.prepare('SELECT count(*) n FROM file_uploads').get()!.n;
  limited(await f.call('/api/import-uploads','POST',{name:'generated-rejected.bin',sizeBytes:PART+17}));
  limited(await f.call('/api/file-sync/v1/uploads','POST',f.revision()));
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM import_uploads').get()!.n,120);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM file_uploads').get()!.n,filesBefore);
  assert.equal((await f.call('/api/import-uploads','POST',importManifest)).status,200,'resume at capacity reuses the admitted identity');
  const resumed=await f.call('/api/file-sync/v1/uploads','POST',fileManifest);assert.equal(resumed.status,200);
  assert.equal((await f.call('/api/file-sync/v1/manifests','POST',{items:[fileManifest]})).status,200,'manifest retries share producer deduplication');
  const tail=Buffer.alloc(17,23);
  assert.equal((await f.call('/api/import-uploads/'+importManifest.id+'/parts/1','PUT',tail)).status,200);
  assert.equal((await f.call('/api/file-sync/v1/uploads/'+resumed.body.uploadId+'/parts/1','PUT',tail)).status,200);
  assert.equal((await f.call('/api/import-uploads','POST',{name:'generated-small.bin',sizeBytes:17})).status,200,'small files do not consume large-file admission');
  assert.equal((await f.call('/api/import-uploads','POST',{name:'generated-other-owner.bin',sizeBytes:PART+17},second)).status,200);
  assert.equal((await f.call('/api/file-sync/v1/uploads','POST',f.revision(),second)).status,200);
  f.advance(60_000);assert.equal((await f.call('/api/import-uploads','POST',{name:'generated-recovered.bin',sizeBytes:PART+17})).status,200);
  assert.equal((await f.call('/api/file-sync/v1/uploads','POST',f.revision())).status,200);
  await f.restart();assert.equal((await f.call('/api/import-uploads','POST',importManifest)).status,200,'restart clears local protection state without dropping admitted data');
});

test('manifest batch admissions cannot bypass the file gate and retry already admitted entries without another charge',async t=>{
  const f=await fixture(t);await f.listen();await f.source();
  const items=Array.from({length:100},()=>f.revision());
  const first=await f.call('/api/file-sync/v1/manifests','POST',{items});assert.equal(first.status,200,first.text);assert.equal(first.body.results.length,100);
  assert.ok(first.body.results.every((entry:{state:string})=>entry.state==='missing_original'));
  const rest=Array.from({length:21},()=>f.revision());limited(await f.call('/api/file-sync/v1/manifests','POST',{items:rest}));
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM file_uploads').get()!.n,120);
  assert.equal((await f.call('/api/file-sync/v1/manifests','POST',{items})).status,200);
  f.advance(60_000);const retry=await f.call('/api/file-sync/v1/manifests','POST',{items:rest});assert.equal(retry.status,200,retry.text);assert.equal(retry.body.results.length,21);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM file_uploads').get()!.n,121);
});

test('the real Desktop queue retains a rate-limited original, resumes after the window and replays a lost ACK at full admission capacity',async t=>{
  const f=await fixture(t);await f.listen();await f.source();
  const fill=async(count:number)=>{const response=await f.call('/api/file-sync/v1/manifests','POST',{items:Array.from({length:count},()=>f.revision())});assert.equal(response.status,200,response.text);};
  await fill(100);await fill(20);
  const bytes=Buffer.concat([Buffer.alloc(PART,31),Buffer.alloc(17,32)]),hash=sha256(bytes);
  const scanned:ScannedItem={externalId:'generated-queued-original',title:'generated-queued.bin',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false,localOriginalBase64:bytes.toString('base64'),metadata:{version:1,file:{sizeBytes:bytes.length}},document:{fileIndex:{version:1,fileId:'generated-queued-original',contentVersion:hash,mode:'archive',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,allowRead:false}}};
  const source:SourceDefinition={id:sourceId,deviceId:'generated-rate-device',name:'Generated rate source',kind:'local-files',platform:'macos',retention:'archive',enabled:true};
  let loseAck=false,partZero=0;
  const request:SourceRequest=async(path,body,method,signal)=>{
    signal?.throwIfAborted();const response=await f.call(path,method,body);
    if(response.status>=400)throw Object.assign(Error('Generated HTTP '+response.status),{httpStatus:response.status});
    if(path.endsWith('/parts/0')){partZero++;if(loseAck){loseAck=false;throw Error('Generated lost durable part ACK');}}
    return response.body;
  };
  const state=join(f.directory,'generated-source-state.json'),first=new SourceSync(state);await first.initialize();
  await first.stage({items:[scanned],seen:[scanned.externalId],skipped:0,complete:true},false,new Date().toISOString());
  await assert.rejects(first.flush(source,request),{httpStatus:429});assert.equal(first.status().pending,1);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM file_uploads').get()!.n,120);
  const retry=new SourceSync(state);await retry.initialize();assert.equal(retry.status().pending,1);
  f.advance(60_000);loseAck=true;await assert.rejects(retry.flush(source,request),/lost durable part ACK/);assert.equal(retry.status().pending,1);
  await fill(100);await fill(19);limited(await f.call('/api/file-sync/v1/uploads','POST',f.revision()));
  const resumed=new SourceSync(state);await resumed.initialize();await resumed.flush(source,request);assert.equal(resumed.status().pending,0);
  assert.equal(partZero,1,'the persisted receipt prevents retransmitting the acknowledged part');
  const saved=f.node.sources.getItem(sourceId,scanned.externalId)!;assert.ok(saved);assert.equal(f.node.files.version(saved.captureId).object_hash,hash);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,1);
  assert.equal(sha256(Buffer.concat([...f.node.files.bytes(saved.captureId)])),hash);
});

test('129 durable tail ACK replays and paged receipt consumers stay outside admission counts in both transports',async t=>{
  const f=await fixture(t);await f.listen();await f.source();const size=300*PART+17,tail=Buffer.alloc(17,19);
  // Metadata-only receipts exercise pagination without rerunning #991's unique
  // >512 MiB byte stream. The real 17-byte tail and its ACK retries use HTTP.
  for(const domain of ['file','import'] as const){
    const route=domain==='file'?'/api/file-sync/v1/uploads':'/api/import-uploads';
    const begin=await f.call(route,'POST',domain==='file'?f.revision(undefined,size):{name:'generated-paged.bin',sizeBytes:size});assert.equal(begin.status,200);
    const id=domain==='file'?begin.body.uploadId:begin.body.id;
    for(let i=0;i<129;i++){
      const put=await f.call(route+'/'+id+'/parts/300','PUT',tail);assert.equal(put.status,200,put.text);assert.equal(put.body.hash,sha256(tail));
    }
    const table=domain==='file'?'file_parts':'import_upload_parts';
    const insert=f.node.store.db.prepare('INSERT INTO '+table+'(upload_id,part,hash,bytes) VALUES(?,?,?,?)');
    for(let part=0;part<300;part++)insert.run(id,part,'a'.repeat(64),PART);
    const response=await f.call(route+'/'+id);assert.equal(response.status,200);const page=response.body as FilePartPage;
    assert.equal(page.parts.length,FILE_PART_RECEIPTS);assert.equal(page.nextPart,255);
    let count=0,reads=0;
    for await(const receipt of filePartReceipts(page,async after=>{reads++;const next=await f.call(route+'/'+id+'?afterPart='+after);assert.equal(next.status,200);return next.body as FilePartPage;},size))assert.equal(receipt.part,count++);
    assert.equal(count,301);assert.equal(reads,1);
  }
});

test('binary HTTP admission precedes buffering, isolates credentials and transports, and releases on abort and parser errors',async t=>{
  const f=await fixture(t);let entered=0;
  f.node.app.addHook('preParsing',async request=>{if(request.headers['x-generated-stall'])entered++;});
  await f.listen();await f.source();const other=await f.session('generated-body-owner-b');
  const began=await f.call('/api/import-uploads','POST',{name:'generated-small.bin',sizeBytes:17}),path='/api/import-uploads/'+began.body.id+'/parts/0';
  const stalled:ClientRequest[]=[];
  t.after(()=>{for(const request of stalled)request.destroy();});
  for(let i=0;i<4;i++){
    const request=httpRequest(f.origin+path,{method:'PUT',headers:{...f.headers(),'content-type':'application/octet-stream','content-length':'17','x-generated-stall':'1'}},response=>response.resume());
    request.on('error',()=>{});request.write(Buffer.alloc(1));stalled.push(request);
  }
  for(let i=0;i<100&&entered<4;i++)await delay(10);
  assert.equal(entered,4,'four admitted requests reach preParsing with incomplete bodies');
  limited(await f.call(path,'PUT',Buffer.alloc(17)), '1');
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM import_upload_parts').get()!.n,0,'denied body never reaches the part writer');
  assert.equal((await f.call('/api/import-uploads/'+began.body.id)).status,200,'receipt reads stay available');
  assert.equal((await f.call(path,'PUT',Buffer.alloc(17),other)).status,200,'another verified credential retains a slot');
  const file=await f.call('/api/file-sync/v1/uploads','POST',f.revision(undefined,17));
  assert.equal((await f.call('/api/file-sync/v1/uploads/'+file.body.uploadId+'/parts/0','PUT',Buffer.alloc(17))).status,200,'the sibling upload transport has its own scope');
  for(const request of stalled)request.destroy();
  for(let i=0;i<100;i++){const response=await f.call(path,'PUT',Buffer.alloc(17));if(response.status===200)break;assert.equal(response.status,429);await delay(10);if(i===99)assert.fail('aborted bodies did not release slots');}
  // Inject the oversized body into the actual parser: a real socket can close
  // while fetch is still writing 4 MiB, surfacing EPIPE instead of its 413.
  for(let i=0;i<5;i++)assert.equal((await f.node.app.inject({url:path,method:'PUT',headers:{...f.headers(),'content-type':'application/octet-stream'},payload:Buffer.alloc(PART+1)})).statusCode,413,'parser failures release, rather than accumulate, receiving slots');
  assert.equal((await f.call(path,'PUT',Buffer.alloc(17))).status,200);
});

test('real commit work stays bounded through client abort, then ACK retries return the same durable original',async t=>{
  const f=await fixture(t),arrived=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let commits=0;
  f.node.app.addHook('preHandler',async request=>{if(request.routeOptions.url==='/api/import-uploads/:id/commit'&&++commits===2)arrived.resolve();});
  await f.listen();await f.source();const other=await f.session('generated-commit-owner-b');
  const bytes=Buffer.alloc(PART,41),tail=Buffer.alloc(17,42),hash=createHash('sha256').update(bytes).update(tail).digest('hex');
  const begin=await f.call('/api/import-uploads','POST',{name:'generated-commit.bin',sizeBytes:PART+17}),id=begin.body.id;
  for(const [part,body] of [bytes,tail].entries())assert.equal((await f.call('/api/import-uploads/'+id+'/parts/'+part,'PUT',body)).status,200);
  const putUpload=f.node.store.assets.putUpload.bind(f.node.store.assets);
  t.mock.method(f.node.store.assets,'putUpload',async(...args:Parameters<typeof putUpload>)=>{
    const result=await putUpload(...args);
    if(args[0].endsWith('/'+id)){entered.resolve();await release.promise;}
    return result;
  });
  const controller=new AbortController(),first=fetch(f.origin+'/api/import-uploads/'+id+'/commit',{method:'POST',headers:f.headers(),signal:controller.signal});
  const aborted=assert.rejects(first,{name:'AbortError'});
  try{
    await entered.promise;
    const second=f.call('/api/import-uploads/'+id+'/commit','POST');
    await arrived.promise;await new Promise<void>(resolve=>setImmediate(resolve));
    limited(await f.call('/api/import-uploads/'+id+'/commit','POST'),'1');
    assert.equal((await f.call('/api/import-uploads/'+id)).status,200);
    const small=await f.call('/api/import-uploads','POST',{name:'generated-other-commit.bin',sizeBytes:0},other);
    assert.equal((await f.call('/api/import-uploads/'+small.body.id+'/commit','POST',undefined,other)).status,200,'another verified credential has commit capacity');
    const manifest=f.revision(undefined,PART+17);manifest.sha256=hash;
    const file=await f.call('/api/file-sync/v1/uploads','POST',manifest);assert.equal(file.status,200,file.text);
    for(const [part,body] of [bytes,tail].entries())assert.equal((await f.call('/api/file-sync/v1/uploads/'+file.body.uploadId+'/parts/'+part,'PUT',body)).status,200);
    assert.equal((await f.call('/api/file-sync/v1/uploads/'+file.body.uploadId+'/commit','POST')).status,200,'file-sync commit capacity is separate');
    controller.abort();await aborted;
    limited(await f.call('/api/import-uploads/'+id+'/commit','POST'),'1');
    assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM archived_files WHERE json_extract(json,'$.name')='generated-commit.bin'").get()!.n,0,'an aborted socket does not free a still-running producer or publish its ACK');
    release.resolve();const saved=await second;assert.equal(saved.status,200,saved.text);assert.equal(saved.body.hash,hash);
    const replay=await f.call('/api/import-uploads/'+id+'/commit','POST');assert.equal(replay.status,200);assert.equal(replay.body.id,saved.body.id);
    const content=await fetch(f.origin+'/api/archived-files/'+saved.body.id+'/content',{headers:f.headers()});assert.equal(content.status,200);assert.equal(sha256(Buffer.from(await content.arrayBuffer())),hash);
    const incomplete=await f.call('/api/import-uploads','POST',{name:'generated-incomplete.bin',sizeBytes:17});
    for(let i=0;i<5;i++)assert.equal((await f.call('/api/import-uploads/'+incomplete.body.id+'/commit','POST')).status,409,'producer failures retain their classification and release commit capacity');
    assert.equal((await f.call('/api/import-uploads/'+id+'/commit','POST')).status,200);
  }finally{controller.abort();release.resolve();await aborted;}
});

test('bounded limiter state does not evict live identities, recovers on expiry, and becomes unavailable after close',()=>{
  let now=0;const limit=new LocalRateLimit(2,()=>now,2);
  limit.take('a');limit.take('b');limit.take('a');
  assert.throws(()=>limit.take('a'),LocalRateLimitError);assert.throws(()=>limit.take('c'),LocalRateLimitError);
  now=60_000;limit.take('c');limit.take('a');limit.close();
  assert.throws(()=>limit.take('a'),{statusCode:503});
});
