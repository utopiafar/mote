import test from 'node:test';
import assert from 'node:assert/strict';
import {keepFixture} from './fixtures/keep-controls.js';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {Originals} from '../src/scope/originals.js';
import {ConfigService} from '../src/config-service.js';
import {defaultProcessingSettings} from '../src/scope/processing-schema.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
async function until(check:()=>boolean|Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await delay(10);}assert.fail('bounded generated condition did not settle');}
function untar(bytes:Buffer){const tar=gunzipSync(bytes),files=new Map<string,Buffer>();for(let offset=0;offset+512<=tar.length;){const header=tar.subarray(offset,offset+512);if(header.every(v=>v===0))break;const name=header.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,''),8);files.set(name,tar.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;}return files;}
async function upload(f:Awaited<ReturnType<typeof keepFixture>>,user:any,text:string,revision='same-revision',externalId='same-file',document?:unknown){
 const source=await f.request(user.token,'/api/ingress/sources','POST',{id:'same-source',name:'Generated source',kind:'local-files',deviceId:'same-device',platform:'import',retention:'archive'});assert.equal(source.status,200,source.text);
 const bytes=Buffer.from(text),sha256=createHash('sha256').update(bytes).digest('hex'),opened=await f.request(user.token,'/api/ingress/sources/same-source/uploads','POST',{batchId:externalId+revision,revision:{sourceId:'same-source',previousRevision:revision==='same-revision'?null:'same-revision',item:{externalId,revision,observedAt:revision==='same-revision'?'2026-01-01T00:00:00Z':'2026-01-02T00:00:00Z',title:'Generated '+text,text:'',kind:'file',layer:'original',mimeType:'text/plain',...(document?{document}:{})},sizeBytes:bytes.length,sha256,relativePath:'generated.txt'}});assert.equal(opened.status,200,opened.text);
 const part=await f.request(user.token,'/api/ingress/uploads/'+opened.json().id+'/parts/0','PUT',{bytes:bytes.toString('base64'),checksum:sha256});assert.equal(part.status,200,part.text);
 const committed=await f.request(user.token,'/api/ingress/uploads/'+opened.json().id+'/commit','POST',{});assert.equal(committed.status,200,committed.text);return committed.json().captures[0];
}

test('KEEP instance execution and safe diagnostic writes have real administrator HTTP contracts',async t=>{
 const f=await keepFixture(t);
 for(const kind of ['execution','diagnostics']){
  const path='/api/admin/'+kind+'-settings',r=await f.request(f.admin.token,path);assert.equal(r.status,200,r.text);
  assert.equal((await f.request(f.a.token,path)).status,403);
 }
});
test('KEEP shared index maintenance has a real administrator HTTP contract',async t=>{
 const f=await keepFixture(t),r=await f.request(f.admin.token,'/api/admin/index');assert.equal(r.status,200,r.text);
 assert.equal((await f.request(f.a.token,'/api/admin/index')).status,403);
});
test('KEEP separate Files metadata and original attachments export requires explicit type and history boundary',async t=>{
 const f=await keepFixture(t),r=await f.request(f.a.token,'/api/files/export?mode=metadata&selection=current&type=text%2Fplain');assert.equal(r.status,200,r.text);
 assert.equal((await f.request(f.a.token,'/api/files/export?mode=metadata')).status,400);
});

test('instance writes use one M04 CAS, survive restart, and reject late administrator revocation',async t=>{
 const f=await keepFixture(t),path='/api/admin/execution-settings',before=(await f.request(f.admin.token,path)).json(),value={interactiveConcurrency:1,agentConcurrency:2,llmConcurrency:1,memoryConcurrency:1};
 const saved=await f.request(f.admin.token,path,'PUT',{...value,revision:before.revision});assert.equal(saved.status,200,saved.text);
 assert.equal((await f.request(f.admin.token,path,'PUT',{...value,revision:before.revision})).status,409);
 assert.equal((await f.request(f.b.token,path,'PUT',{...value,revision:saved.json().revision})).status,403);
 await f.restart();const restarted=(await f.request(f.admin.token,path)).json();for(const [key,n]of Object.entries(value))assert.equal(restarted[key],n);
 const d='/api/admin/diagnostics-settings',read=(await f.request(f.admin.token,d)).json();assert.equal((await f.request(f.admin.token,d,'PUT',{revision:read.revision,enabled:false,debug:true,level:'debug',traceEnabled:true})).status,400);
 assert.equal((await f.request(f.admin.token,d,'PUT',{revision:read.revision,enabled:false,debug:false,level:'warn',traceEnabled:false})).status,200);
 const snapshot=(await f.request(f.admin.token,'/api/diagnostics')).json();assert.equal(snapshot.enabled,false);assert.equal(snapshot.coverage.privateTraces,false);
 const created=await f.request(f.admin.token,'/api/admin/accounts','POST',{username:'generated-second-admin',password:'Generated-only-password-2026',administrator:true});assert.equal(created.status,200,created.text);const second=await f.login('generated-second-admin');
 const entered=deferred(),release=deferred(),original=ConfigService.prototype.setHandler;let nextPrepare:any;
 // Wrap the real M16 prepare callback on this sole generated instance.
 const domains=(f.node.configuration.instance as any).domains,registered=domains.get('diagnostics'),prepare=registered.prepare;nextPrepare=async(...args:any[])=>{entered.resolve();await release.promise;return prepare(...args);};registered.prepare=nextPrepare;t.after(()=>{registered.prepare=prepare;release.resolve();});
 const revision=(await f.request(f.admin.token,d)).json().revision,pending=f.request(f.admin.token,d,'PUT',{revision,enabled:true,debug:true,level:'debug',traceEnabled:false});await entered.promise;
 assert.equal((await f.request(second.token,'/api/admin/accounts/'+f.admin.userId,'PATCH',{disabled:true})).status,200);release.resolve();assert.equal((await pending).status,401);
 const after=(await f.request(second.token,d)).json();assert.equal(after.revision,revision);assert.equal(after.enabled,false);assert.equal(ConfigService.prototype.setHandler,original);
});

test('live M05 harness limits preserve issued occupancy, cancellation and A/B ownership',async t=>{
 const f=await keepFixture(t),entered:string[]=[],release=deferred(),kind='keep.physical-model';t.after(()=>release.resolve());
 f.node.execution!.register({kind,pool:kind,concurrency:()=>8,policy:EXECUTION_POLICIES.modelCall,parseInput:raw=>z.object({label:z.string()}).strict().parse(raw),execute:async run=>{entered.push(String(run.task.input.label));run.external.begin('generated-physical');await release.promise;run.external.complete();return {};}});
 const r=(await f.request(f.admin.token,'/api/admin/execution-settings')).json();assert.equal((await f.request(f.admin.token,'/api/admin/execution-settings','PUT',{revision:r.revision,interactiveConcurrency:1,agentConcurrency:2,llmConcurrency:2,memoryConcurrency:1})).status,200);
 const submit=async(user:any,label:string)=>{const r=await f.request(user.token,'/api/tasks','POST',{kind,operationId:label,input:{label}});assert.equal(r.status,200,r.text);return r.json();};
 const a=await submit(f.a,'A1'),b=await submit(f.b,'B1');await until(()=>entered.length===2);
 const current=(await f.request(f.admin.token,'/api/admin/execution-settings')).json();await f.request(f.admin.token,'/api/admin/execution-settings','PUT',{revision:current.revision,interactiveConcurrency:1,agentConcurrency:1,llmConcurrency:1,memoryConcurrency:1});await submit(f.a,'A2');await delay(80);assert.equal(entered.length,2);
 assert.equal((await f.request(f.b.token,'/api/tasks/'+a.id)).status,404);
 await f.request(f.a.token,'/api/tasks/'+a.id+'/cancel','POST',{});const view=(await f.request(f.admin.token,'/api/admin/execution-settings')).json();assert.equal(view.queues.models.active,2,'cancelled logical work still owns its physical slot');
 release.resolve();await until(()=>entered.includes('A2'));await until(async()=>['stale','cancelled'].includes((await f.request(f.a.token,'/api/tasks/'+a.id)).json().state));assert.equal((await f.request(f.b.token,'/api/tasks/'+b.id)).status,200);
});

test('shared index repairs generated corruption, is idempotent and excludes retired B/source after queued await',async t=>{
 const f=await keepFixture(t),a=await upload(f,f.a,'GENERATED_INDEX_A'),b=await upload(f,f.b,'GENERATED_INDEX_B');assert.equal(a.id,b.id);
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));t.after(()=>db.close());db.exec('DELETE FROM pd_fts');
 const lock=deferred(),entered=deferred(),kind='keep.index-lock';t.after(()=>lock.resolve());f.node.execution!.register({kind,pool:kind,concurrency:()=>1,policy:EXECUTION_POLICIES.control,parseInput:()=>({}),resources:()=>[{scope:'shared',key:'lexical-index-maintenance'}],execute:async run=>{entered.resolve();await Promise.race([lock.promise,new Promise<void>(resolve=>run.signal.addEventListener('abort',()=>resolve(),{once:true}))]);return {};}});
 await f.request(f.admin.token,'/api/tasks','POST',{kind,operationId:'generated-lock',input:{}});await entered.promise;
 const operationId=randomUUID(),first=await f.request(f.admin.token,'/api/admin/index/rebuild','POST',{operationId});assert.equal(first.status,200,first.text);const duplicate=await f.request(f.admin.token,'/api/admin/index/rebuild','POST',{operationId});assert.equal(duplicate.json().id,first.json().id);
 assert.equal((await f.request(f.b.token,'/api/sources/same-source','PATCH',{enabled:false})).status,200);
 lock.resolve();await until(async()=>(await f.request(f.admin.token,'/api/admin/index')).json().job?.state==='succeeded');
 assert.ok(Number(db.prepare('SELECT count(*) n FROM pd_fts WHERE user_id=?').get(f.a.userId)!.n)>0);assert.equal(Number(db.prepare('SELECT count(*) n FROM pd_fts WHERE user_id=?').get(f.b.userId)!.n),0);
 const safe=await f.request(f.admin.token,'/api/admin/index');assert.doesNotMatch(safe.text,/GENERATED_INDEX|same-source|generated-[ab]/);
 assert.equal((await f.request(f.a.token,'/api/admin/index/rebuild','POST',{operationId:randomUUID()})).status,403);
 await f.restart();assert.equal((await f.request(f.admin.token,'/api/admin/index/rebuild','POST',{operationId})).json().id,first.json().id);
});

test('split Files exports parse exact A/B current and retained-history bytes; metadata opens no original bytes',async t=>{
 const f=await keepFixture(t),a=await upload(f,f.a,'ORIGINAL_GENERATED_A'),b=await upload(f,f.b,'ORIGINAL_GENERATED_B');assert.equal(a.id,b.id);await upload(f,f.a,'REPLACEMENT_GENERATED_A','revision-2');
 const original=Originals.prototype.read;let byteReads=0;Originals.prototype.read=function(ref,range){if((range?.length??1)>0)byteReads++;return original.call(this,ref,range);};t.after(()=>Originals.prototype.read=original);
 const path='/api/files/export?type=text%2Fplain&selection=',metadata=await f.request(f.a.token,path+'current&mode=metadata');assert.equal(metadata.status,200,metadata.text);const meta=untar(metadata.bytes);assert.deepEqual([...meta.keys()],['metadata.json']);assert.equal(byteReads,0);
 const manifest=JSON.parse(meta.get('metadata.json')!.toString());assert.equal(manifest.originals.length,1);assert.equal(manifest.originals[0].current,true);assert.doesNotMatch(meta.get('metadata.json')!.toString(),/ORIGINAL_GENERATED_B|apiKey|configFile/);
 const data=untar((await f.request(f.a.token,path+'history&mode=data')).bytes),history=JSON.parse(data.get('metadata.json')!.toString());assert.equal(history.originals.length,2);assert.equal(history.originals.filter((r:any)=>r.current).length,1);
 for(const file of history.originals){const bytes=data.get(file.member)!;assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);assert.equal(bytes.length,file.sizeBytes);}assert.ok([...data.values()].some(bytes=>bytes.toString()==='ORIGINAL_GENERATED_A'));
 const ownB=untar((await f.request(f.b.token,path+'current&mode=data')).bytes);assert.ok([...ownB.values()].some(bytes=>bytes.toString()==='ORIGINAL_GENERATED_B'));assert.ok(![...ownB.values()].some(bytes=>bytes.toString().includes('ORIGINAL_GENERATED_A')));
});

test('late source retirement aborts export before any further original byte reader',async t=>{
 const entered=deferred(),release=deferred();let hold=false;
 const f=await keepFixture(t,node=>node.app.addHook('onSend',async(request,_reply,payload)=>{if(hold&&request.url.startsWith('/api/files/export')){entered.resolve();await release.promise;}return payload;}));t.after(()=>release.resolve());await upload(f,f.a,'STREAM_GENERATED_A');
 const original=Originals.prototype.read;let byteReads=0;Originals.prototype.read=function(ref,range){if((range?.length??1)>0)byteReads++;return original.call(this,ref,range);};t.after(()=>Originals.prototype.read=original);
 hold=true;const pending=f.request(f.a.token,'/api/files/export?mode=data&selection=current&type=text%2Fplain').catch(error=>({status:0,bytes:Buffer.alloc(0),text:String(error)}));await entered.promise;
 assert.equal((await f.request(f.a.token,'/api/sources/same-source','PATCH',{enabled:false})).status,200);release.resolve();const response=await pending;assert.equal(byteReads,0);assert.throws(()=>gunzipSync(response.bytes));
});

test('queued index cancellation and restart preserve one accepted operation without duplicate publication',async t=>{
 const f=await keepFixture(t);await upload(f,f.a,'GENERATED_RESTART_INDEX');const db=new DatabaseSync(join(f.directory,'mote.sqlite'));t.after(()=>db.close());db.exec('DELETE FROM pd_fts');
 const entered=deferred(),release=deferred(),kind='keep.restart-lock';t.after(()=>release.resolve());f.node.execution!.register({kind,pool:kind,concurrency:()=>1,policy:EXECUTION_POLICIES.control,parseInput:()=>({}),resources:()=>[{scope:'shared',key:'lexical-index-maintenance'}],execute:async run=>{entered.resolve();await Promise.race([release.promise,new Promise<void>(resolve=>run.signal.addEventListener('abort',()=>resolve(),{once:true}))]);return {};}});
 await f.request(f.admin.token,'/api/tasks','POST',{kind,operationId:'generated-restart-lock',input:{}});await entered.promise;
 const cancelled=(await f.request(f.admin.token,'/api/admin/index/rebuild','POST',{operationId:randomUUID()})).json();assert.equal((await f.request(f.admin.token,'/api/admin/index/'+cancelled.id+'/cancel','POST',{})).json().state,'cancelled');assert.equal(Number(db.prepare('SELECT count(*) n FROM pd_fts').get()!.n),0);
 const operationId=randomUUID(),pending=(await f.request(f.admin.token,'/api/admin/index/rebuild','POST',{operationId})).json();assert.equal(pending.state,'waiting');await f.restart();await until(async()=>(await f.request(f.admin.token,'/api/admin/index')).json().job?.state==='succeeded');
 assert.equal((await f.request(f.admin.token,'/api/admin/index/rebuild','POST',{operationId})).json().id,pending.id);assert.equal(Number(db.prepare('SELECT count(*) n FROM execution_steps WHERE id=?').get(pending.id)!.n),1);assert.ok(Number(db.prepare('SELECT count(*) n FROM pd_fts').get()!.n)>0);
});

test('declared attachments and more than one Files page export completely with exact checksums',async t=>{
 const f=await keepFixture(t),config=(await f.request(f.a.token,'/api/configuration')).json();assert.equal((await f.request(f.a.token,'/api/configuration/processing','PUT',{revision:config.revision,value:{...defaultProcessingSettings(),enabled:false,automatic:false}})).status,200);
 const bytes=Buffer.from('GENERATED_DECLARED_ATTACHMENT'),id=randomUUID();
 const opened=await f.request(f.a.token,'/api/import-uploads','POST',{id,name:'generated-attachment.txt',sizeBytes:bytes.length,mimeType:'text/plain'});assert.equal(opened.status,200,opened.text);
 assert.equal((await f.request(f.a.token,'/api/import-uploads/'+id+'/parts/0','PUT',bytes)).status,200);
 const committed=await f.request(f.a.token,'/api/import-uploads/'+id+'/commit','POST',{});assert.equal(committed.status,200,committed.text);const file=committed.json();
 const parent=await upload(f,f.a,'GENERATED_ATTACHMENT_PARENT','same-revision','same-file',{attachments:[{id:file.id,name:file.name,mimeType:file.mimeType}]});
 // Seed the remaining page through the real, context-bound M03 publisher used
 // by connectors. The first original and attachment use HTTP upload above;
 // the final complete export below uses real HTTP and real object readers.
 const context=await f.node.authority.authenticate(f.a.token),ingress=f.node.ingress.forUser(context);ingress.attachArchivedFiles(parent.id,[file.id]);
 const items=Array.from({length:101},(_,n)=>({externalId:'page-'+n,revision:'same-revision',observedAt:'2026-01-01T00:00:00Z',title:'Generated page '+n,text:'',kind:'file',layer:'original',mimeType:'text/plain'}));
 ingress.receiveSourceItemsWithOriginals('same-source','generated-pages',items,items.map((_,n)=>({bytes:Buffer.from('GENERATED_PAGE_'+n),mime:'text/plain',format:'file'})));
 const response=await f.request(f.a.token,'/api/files/export?mode=data&selection=current&type=text%2Fplain');assert.equal(response.status,200,response.text);const files=untar(response.bytes),manifest=JSON.parse(files.get('metadata.json')!.toString());assert.equal(manifest.originals.length,102);assert.equal(manifest.attachments.length,1);assert.deepEqual(files.get(manifest.attachments[0].member),bytes);assert.equal(createHash('sha256').update(files.get(manifest.attachments[0].member)!).digest('hex'),file.hash);
 const metadata=untar((await f.request(f.a.token,'/api/files/export?mode=metadata&selection=current&type=text%2Fplain')).bytes);assert.deepEqual([...metadata.keys()],['metadata.json']);
 const b=untar((await f.request(f.b.token,'/api/files/export?mode=data&selection=current&type=text%2Fplain')).bytes);assert.equal(JSON.parse(b.get('metadata.json')!.toString()).attachments.length,0);
});

test('Files export honors the existing size bound and MIME literals; a revoked session cannot finish a held stream',async t=>{
 const limited=await keepFixture(t,undefined,{version:1,revision:0,storage:{maxExportBytes:128}});await upload(limited,limited.a,'GENERATED_SIZE_BOUND');assert.equal((await limited.request(limited.a.token,'/api/files/export?mode=metadata&selection=current&type=*%2F*')).status,413);
 const entered=deferred(),release=deferred();let hold=false;const f=await keepFixture(t,node=>node.app.addHook('onSend',async(request,_reply,payload)=>{if(hold&&request.url.startsWith('/api/files/export')){entered.resolve();await release.promise;}return payload;}));t.after(()=>release.resolve());await upload(f,f.a,'GENERATED_SESSION_RETIREMENT');
 const context=await f.node.authority.authenticate(f.a.token),ingress=f.node.ingress.forUser(context),items=['text/x+a','text/xba'].map((mimeType,index)=>({externalId:'literal-'+index,revision:'same-revision',observedAt:'2026-01-01T00:00:00Z',title:'Generated literal '+index,text:'',kind:'file',layer:'original',mimeType}));ingress.receiveSourceItemsWithOriginals('same-source','generated-mime-literals',items,items.map(item=>({bytes:Buffer.from(item.mimeType),mime:item.mimeType,format:'file'})));
 assert.equal((await f.request(f.a.token,'/api/files/export?mode=data&selection=current&type=text%2Fx_a')).status,400);const selected=await f.request(f.a.token,'/api/files/export?mode=data&selection=current&type=text%2Fx%2Ba');assert.equal(selected.status,200,selected.text);const exact=untar(selected.bytes);assert.equal(JSON.parse(exact.get('metadata.json')!.toString()).originals.length,1);
 hold=true;const pending=f.request(f.a.token,'/api/files/export?mode=data&selection=current&type=text%2Fplain').catch(error=>({bytes:Buffer.alloc(0),text:String(error)}));await entered.promise;assert.equal((await f.request(f.a.token,'/api/auth/logout','POST',{})).status,200);release.resolve();const retired=await pending;assert.throws(()=>gunzipSync(retired.bytes));assert.equal((await f.request(f.b.token,'/api/files/export?mode=metadata&selection=current&type=text%2Fplain')).status,200);
});

test('unchanged complete Files exports avoid quadratic incarnation reads across TAR blocks',async t=>{
 const f=await keepFixture(t);assert.equal((await f.request(f.a.token,'/api/ingress/sources','POST',{id:'same-source',name:'Generated bulk source',kind:'local-files',deviceId:'same-device',platform:'import',retention:'archive'})).status,200);
 const context=await f.node.authority.authenticate(f.a.token),ingress=f.node.ingress.forUser(context),bytes=Buffer.from('GENERATED_LINEAR_EXPORT'),seed=(start:number,end:number)=>{const items=Array.from({length:end-start},(_,offset)=>({externalId:'generated-'+(start+offset),revision:'r1',observedAt:'2026-01-01T00:00:00Z',title:'Generated original',text:'',kind:'file' as const,layer:'original' as const,mimeType:'text/plain'}));ingress.receiveSourceItemsWithOriginals('same-source','generated-batch-'+start,items,items.map(()=>({bytes,mime:'text/plain',format:'file'})));};
 const prepare=DatabaseSync.prototype.prepare;let reads=0;DatabaseSync.prototype.prepare=function(sql){if(sql.includes('ig_file_generations'))reads++;return prepare.call(this,sql);};t.after(()=>{DatabaseSync.prototype.prepare=prepare;});
 const exportCount=async(expected:number)=>{reads=0;const response=await f.request(f.a.token,'/api/files/export?mode=data&selection=current&type=text%2Fplain');assert.equal(response.status,200,response.text);const archive=untar(response.bytes),manifest=JSON.parse(archive.get('metadata.json')!.toString());assert.equal(manifest.originals.length,expected);for(const item of manifest.originals){assert.deepEqual(archive.get(item.member),bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256);}return reads;};
 seed(0,8);const small=await exportCount(8);seed(8,16);const large=await exportCount(16);t.diagnostic(JSON.stringify({small,large}));assert.ok(large<=small*3,'doubling an unchanged export must not quadruple full-set incarnation reads: '+JSON.stringify({small,large}));
});

test('a source revocation committed by another SQLite connection retires a held metadata stream',async t=>{
 const entered=deferred(),release=deferred();let hold=false;
 const f=await keepFixture(t,node=>node.app.addHook('onSend',async(request,_reply,payload)=>{if(hold&&request.url.startsWith('/api/files/export')){entered.resolve();await release.promise;}return payload;}));t.after(()=>release.resolve());await upload(f,f.a,'GENERATED_EXTERNAL_REVOKE_A');await upload(f,f.b,'GENERATED_EXTERNAL_REVOKE_B');
 hold=true;const pending=f.request(f.a.token,'/api/files/export?mode=metadata&selection=current&type=text%2Fplain').catch(error=>({status:0,bytes:Buffer.alloc(0),text:String(error)}));await entered.promise;
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));try{const changed=db.prepare("UPDATE pd_sources SET json=json_set(json,'$.enabled',json('false')) WHERE user_id=? AND id=?").run(f.a.userId,'same-source');assert.equal(Number(changed.changes),1);}finally{db.close();}
 release.resolve();const response=await pending;assert.throws(()=>gunzipSync(response.bytes));hold=false;
 const positive=await f.request(f.b.token,'/api/files/export?mode=metadata&selection=current&type=text%2Fplain');assert.equal(positive.status,200,positive.text);const metadata=untar(positive.bytes).get('metadata.json')!.toString();assert.match(metadata,/GENERATED_EXTERNAL_REVOKE_B/);assert.doesNotMatch(metadata,/GENERATED_EXTERNAL_REVOKE_A/);
});
