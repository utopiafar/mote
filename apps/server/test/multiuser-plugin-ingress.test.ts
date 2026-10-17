import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {buildApp} from '../src/app.js';
import {generatedScopedPluginRelease,generatedScopedPluginSource} from './fixtures/scoped-plugin-release.js';

const password='Generated-joint-plugin-01',protocol={'x-mote-protocol-version':'2','x-mote-ingress-version':'3'};
const item=(id:string,text='Generated source body')=>({externalId:id,revision:'same-revision',observedAt:'2026-10-15T00:00:00Z',title:'Generated original',text,kind:'message',layer:'original'});
const capture=(id:string,text:string)=>({id,deviceId:'same-device',deviceName:'Generated device',platform:'import',capturedAt:'2026-10-15T00:00:00Z',durationMs:0,source:'screen',ocrText:'',imageBase64:Buffer.from(text).toString('base64'),imageMime:'image/png',ocr:{status:'pending'}});
const material=(id:string,captureId:string,sourceId='allowed-source')=>({id:'mat_'+createHash('sha256').update(JSON.stringify([sourceId,id])).digest('hex'),kind:'document',schemaVersion:1,title:'Generated projection',origin:{sourceId,externalId:id,deviceId:'same-device'},blocks:[{id:'text',kind:'text',format:'plain',text:'Generated projection body',memberIds:['capture']}],members:[{id:'capture',kind:'capture',ref:'capture:'+captureId}],coverage:{state:'complete'},fidelity:{state:'derived',limitations:[]},retention:{original:'retained',policy:'keep'}});
async function until(check:()=>boolean,message:string){const end=Date.now()+10000;while(!check()){if(Date.now()>end)assert.fail(message);await delay(5);}}
function find(directory:string,name:string):string|undefined{if(!existsSync(directory))return;for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.name===name)return path;if(entry.isDirectory()){const result=find(path,name);if(result)return result;}}}

// The fixture gate is inside trusted generated plugin code and its own cwd.
// Every RPC still traverses the production binder and real M03 transactions.
const code=generatedScopedPluginSource.replace("import {readFile,writeFile} from 'node:fs/promises';","import {readFile,writeFile,rename} from 'node:fs/promises';").replace("if(input.method)return host.call(input.method,input.args??[]);",String.raw`
  if(input.method){
   const key=input.waitForRelease;if(key&&!/^[a-z0-9-]+$/.test(key))throw Error('bad_generated_gate');
   if(key){await writeFile('joint-entered-'+key+'.pending',String(process.pid));await rename('joint-entered-'+key+'.pending','joint-entered-'+key);for(;;){try{await readFile('joint-release-'+key);break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}}}
   try{const result=await host.call(input.method,input.args??[]);if(input.emitAfterRelease)await host.call('emit',{late:true});return result;}
   finally{if(key)await writeFile('joint-attempted-'+key,'attempted');}
  }`);

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-m03-m09-joint-')),release=generatedScopedPluginRelease('9',code),nodes:Awaited<ReturnType<typeof buildApp>>[]=[];
 let node=await buildApp({dataDir:directory},{pluginReleaseTransport:release.transport});nodes.push(node);const db=new DatabaseSync(join(directory,'mote.sqlite'));
 t.after(async()=>{for(const current of nodes.reverse())await current.app.close();db.close();rmSync(directory,{recursive:true,force:true});});
 const request=(token:string|undefined,url:string,method:any='GET',payload?:unknown)=>node.app.inject({url,method,headers:{...protocol,...(token?{authorization:'Bearer '+token}:{})},...(payload===undefined?{}:{payload})});
 const checked=async(token:string|undefined,url:string,method:any='GET',payload?:unknown)=>{const response=await request(token,url,method,payload);assert.equal(response.statusCode,200,response.body);return response.json();};
 await node.accounts!.initialize('generated-admin',password);const login=(username:string)=>checked(undefined,'/api/auth/login','POST',{username,password,mode:'client'}),admin=await login('generated-admin');
 const a=await checked(admin.token,'/api/admin/accounts','POST',{username:'generated-a',password}),b=await checked(admin.token,'/api/admin/accounts','POST',{username:'generated-b',password}),alice=await login('generated-a'),bob=await login('generated-b');
 const preview=await checked(admin.token,'/api/plugins/resolve','POST',{repository:release.repository,tag:release.tag}),catalog=await checked(admin.token,'/api/admin/plugins'),installed=await checked(admin.token,'/api/plugins/install','POST',{previewId:preview.id,expectedRevision:catalog.revision,operationId:randomUUID()}),packageId=installed.packages[0].id;
 await until(()=>node.plugins!.catalog.view().packages[0].state==='installed','generated local release did not install');
 const view=(token:string)=>checked(token,'/api/plugins');
 const configure=async(token:string,instance:unknown)=>checked(token,'/api/plugin-instances','POST',{instance,expectedRevision:(await view(token)).revision});
 const action=async(token:string,action:string)=>checked(token,'/api/plugin-instances/same-instance/'+action,'POST',action==='check'?{}:{expectedRevision:(await view(token)).revision});
 const admit=(token:string)=>checked(token,'/api/plugin-instances/same-instance/snapshots','POST',{});
 const source=async(token:string,id:string,retention='archive')=>checked(token,'/api/ingress/sources','POST',{id,name:'Generated '+id,kind:retention==='archive'?'coding-agent':'custom',deviceId:'same-device',platform:'import',retention});
 for(const [token,label] of [[alice.token,'A'],[bob.token,'B_PRIVATE']]){await source(token,'allowed-source');await source(token,'other-source');await configure(token,{id:'same-instance',packageId,name:'Generated source plugin',configuration:{label},desired:false,grants:{capabilities:['source'],sourceIds:['allowed-source'],history:false}});await action(token,'check');await action(token,'enable');}
 const snapshots={a:await admit(alice.token),b:await admit(bob.token)};
 const submit=(token:string,snapshot:string,method:string,args:unknown[],extra:Record<string,unknown>={})=>checked(token,'/api/plugin-snapshots/'+snapshot+'/invoke','POST',{componentId:'generated.source',payload:{method,args,...extra},operationId:randomUUID()});
 const wait=async(token:string,id:string,state='succeeded')=>{const deadline=Date.now()+10000;for(;;){const value=await checked(token,'/api/tasks/'+id);if(value.state===state)return value;if(Date.now()>deadline)assert.fail(JSON.stringify(value));await delay(5);}};
 const rpc=async(token:string,snapshot:string,method:string,args:unknown[],state='succeeded')=>wait(token,(await submit(token,snapshot,method,args)).id,state);
 const restart=async()=>{await node.app.close();node=await buildApp({dataDir:directory},{pluginReleaseTransport:release.transport});nodes.push(node);};
 return {directory,get node(){return node;},db,request,checked,admin,a,b,alice,bob,view,configure,action,admit,source,snapshots,submit,wait,rpc,restart};
}

test('actual generated source component receives, pages and reads real M03 originals with fixed source and user isolation',async t=>{
 const f=await fixture(t),id=randomUUID();
 const ar=(await f.rpc(f.alice.token,f.snapshots.a.id,'receiveCaptures',['allowed-source','same-batch',[capture(id,'A_ORIGINAL')]])).result,br=(await f.rpc(f.bob.token,f.snapshots.b.id,'receiveCaptures',['allowed-source','same-batch',[capture(id,'B_PRIVATE_ORIGINAL')]])).result;
 const a=ar.captures[0].original.ref,b=br.captures[0].original.ref;assert.notEqual(a,b);assert.equal(ar.userId,f.a.userId);assert.equal(br.userId,f.b.userId);
 const read=(await f.rpc(f.alice.token,f.snapshots.a.id,'readOriginal',[a,{offset:2,length:5}])).result;assert.deepEqual(read.bytes,{type:'Buffer',data:[...Buffer.from('A_ORIGINAL').subarray(2,7)]});assert.equal(read.sourceId,'allowed-source');
 const page=(await f.rpc(f.alice.token,f.snapshots.a.id,'pageOriginals',['allowed-source','',10])).result;assert.deepEqual(page.items.map((value:any)=>value.ref),[a]);assert.equal(JSON.stringify(page).includes('B_PRIVATE'),false);
 await f.rpc(f.alice.token,f.snapshots.a.id,'readOriginal',[b],'blocked');await f.rpc(f.alice.token,f.snapshots.a.id,'pageOriginals',['other-source'],'blocked');await f.rpc(f.alice.token,f.snapshots.a.id,'receiveSourceItems',['other-source','denied',[item('denied')]],'blocked');
 await f.rpc(f.alice.token,f.snapshots.a.id,'receiveCaptures',['allowed-source','selector',[{...capture(randomUUID(),'FORGED_SELECTOR'),userId:f.b.userId}]],'blocked');
 for(const method of ['withWorkspace','registerSource','db','forUser'])await f.rpc(f.alice.token,f.snapshots.a.id,method,[],'blocked');
 const device=await f.checked(f.alice.token,'/api/login/session','POST',{serverUrl:'https://generated.invalid',deviceId:'same-device',deviceName:'Generated restricted collector',platform:'android'});
 assert.equal((await f.request(device.token,'/api/plugins')).statusCode,403);assert.equal((await f.request(device.token,'/api/plugin-snapshots/'+f.snapshots.a.id+'/invoke','POST',{componentId:'generated.source',payload:{method:'pageOriginals',args:['allowed-source']},operationId:randomUUID()})).statusCode,403);
 assert.equal(f.db.prepare('SELECT count(*) n FROM pd_source_heads WHERE user_id=? AND source_id=?').get(f.a.userId,'other-source')!.n,0);
});

test('real source plugin publication rejects same-user cross-source captures and transitive Materials before commit',async t=>{
 const f=await fixture(t),a=(await f.rpc(f.alice.token,f.snapshots.a.id,'receiveSourceItems',['allowed-source','archive',[item('same-external','A_ARCHIVE')]])).result,b=(await f.rpc(f.bob.token,f.snapshots.b.id,'receiveSourceItems',['allowed-source','archive',[item('same-external','B_PRIVATE_ARCHIVE')]])).result;
 const read=(await f.rpc(f.alice.token,f.snapshots.a.id,'readOriginal',[a.captures[0].original.ref])).result;assert.equal(JSON.parse(Buffer.from(read.bytes.data).toString()).text,'A_ARCHIVE');assert.notEqual(a.captures[0].original.ref,b.captures[0].original.ref);
 const foreign=await f.checked(f.alice.token,'/api/ingress/sources/other-source/items','POST',{batchId:'outside-plugin',items:[item('other','UNGRANTED_BODY')]}),bad=material('bad',foreign.captures[0].id);
 await f.rpc(f.alice.token,f.snapshots.a.id,'readOriginal',[foreign.captures[0].original.ref],'blocked');
 await f.rpc(f.alice.token,f.snapshots.a.id,'publishMaterial',[bad],'blocked');
 const outside=material('outside',foreign.captures[0].id,'other-source'),external=f.node.ingress.forUser(await f.node.authority.authenticate(f.alice.token)).publishMaterial(outside),transitive={...material('transitive',a.captures[0].id),members:[{id:'capture',kind:'material',ref:external.id}]};
 await f.rpc(f.alice.token,f.snapshots.a.id,'publishMaterial',[transitive],'blocked');
 const published=(await f.rpc(f.alice.token,f.snapshots.a.id,'publishMaterial',[material('good',a.captures[0].id)])).result;assert.equal(published.origin.sourceId,'allowed-source');
 assert.equal(f.db.prepare('SELECT count(*) n FROM pd_materials WHERE user_id=? AND id IN (?,?)').get(f.a.userId,bad.id,transitive.id)!.n,0);
 assert.equal((await f.rpc(f.bob.token,f.snapshots.b.id,'readOriginal',[b.captures[0].original.ref])).state,'succeeded');
});

test('pause drains an already admitted real source RPC while blocking new admission without affecting B',async t=>{
 const f=await fixture(t),key='pause-'+randomUUID(),task=await f.submit(f.alice.token,f.snapshots.a.id,'receiveSourceItems',['allowed-source','drain',[item('drain')]],{waitForRelease:key});let entered:string|undefined;
 await until(()=>Boolean(entered=find(join(f.directory,'plugins','instances'),'joint-entered-'+key)),'source worker did not enter');await f.action(f.alice.token,'pause');assert.equal((await f.request(f.alice.token,'/api/plugin-instances/same-instance/snapshots','POST',{})).statusCode,409);writeFileSync(join(dirname(entered!),'joint-release-'+key),'release');await f.wait(f.alice.token,task.id);
 await f.rpc(f.bob.token,f.snapshots.b.id,'receiveSourceItems',['allowed-source','b-drain',[item('b-drain')]]);assert.equal(f.db.prepare('SELECT count(*) n FROM pd_source_heads WHERE user_id=? AND external_id=?').get(f.a.userId,'drain')!.n,1);
});

for(const mode of ['stop','grant-revoke','plugin-delete','ingress-delete','account-disable'] as const)test('real source late RPC and subscription cannot publish after '+mode+', while B continues',async t=>{
 const f=await fixture(t),key=mode+'-'+randomUUID(),events:unknown[]=[],context=await f.node.authority.authenticate(f.alice.token);f.node.plugins!.forUser(context).subscribe(f.snapshots.a.id,event=>events.push(event));
 const task=await f.submit(f.alice.token,f.snapshots.a.id,'receiveSourceItems',['allowed-source','late-'+mode,[item('late-'+mode)]],{waitForRelease:key,emitAfterRelease:true});let entered:string|undefined;await until(()=>Boolean(entered=find(join(f.directory,'plugins','instances'),'joint-entered-'+key)),'source worker did not enter');const directory=dirname(entered!),pid=Number(readFileSync(entered!,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0,'generated worker marker must name one real process');
 if(mode==='stop')await f.action(f.alice.token,'stop');
 if(mode==='grant-revoke'){await f.action(f.alice.token,'pause');const instance=(await f.view(f.alice.token)).instances[0];delete instance.generation;delete instance.checked;delete instance.secretStatus;delete instance.capabilities;instance.grants.sourceIds=[];await f.configure(f.alice.token,instance);}
 if(mode==='plugin-delete')assert.equal((await f.node.services.forUser(context).deleteUser('plugins','joint-delete-plugins')).status,'complete');
 if(mode==='ingress-delete')assert.equal((await f.node.services.forUser(context).deleteUser('ingress','joint-delete-ingress')).status,'complete');
 if(mode==='account-disable')await f.checked(f.admin.token,'/api/admin/accounts/'+f.a.userId,'PATCH',{disabled:true});
 if(mode==='ingress-delete'||mode==='account-disable'){writeFileSync(join(directory,'joint-release-'+key),'release');await until(()=>existsSync(join(directory,'joint-attempted-'+key)),'revoked source worker did not attempt its actual RPC');}
 else{await until(()=>{try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}},'retired source process remained alive');if(existsSync(directory))writeFileSync(join(directory,'joint-release-'+key),'release');assert.equal(existsSync(join(directory,'joint-attempted-'+key)),false);}
 await until(()=>f.node.execution!.engine.get(task.id)?.state==='stale','late source task did not become stale');assert.equal(f.db.prepare('SELECT result FROM user_tasks WHERE task_id=?').get(task.id)!.result,null);assert.deepEqual(events,[]);assert.equal(f.db.prepare('SELECT count(*) n FROM pd_source_heads WHERE user_id=? AND external_id=?').get(f.a.userId,'late-'+mode)!.n,0);
 const other=(await f.rpc(f.bob.token,f.snapshots.b.id,'receiveSourceItems',['allowed-source','b-'+mode,[item('b-'+mode)]])).result;assert.equal(other.userId,f.b.userId);
});

test('restart preserves actual source receipts, original bytes, fixed instance configuration and source restrictions',async t=>{
 const f=await fixture(t),args=['allowed-source','restart',[item('restart','A_FIXED_ARCHIVE')]],before=(await f.rpc(f.alice.token,f.snapshots.a.id,'receiveSourceItems',args)).result;
 await f.rpc(f.bob.token,f.snapshots.b.id,'receiveSourceItems',['allowed-source','restart',[item('restart','B_PRIVATE_ARCHIVE')]]);await f.restart();
 assert.deepEqual((await f.rpc(f.alice.token,f.snapshots.a.id,'receiveSourceItems',args)).result,before);
 const value=(await f.rpc(f.alice.token,f.snapshots.a.id,'readOriginal',[before.captures[0].original.ref])).result;assert.equal(JSON.parse(Buffer.from(value.bytes.data).toString()).text,'A_FIXED_ARCHIVE');assert.equal((await f.view(f.alice.token)).instances[0].configuration.label,'A');
 await f.rpc(f.alice.token,f.snapshots.a.id,'receiveSourceItems',['other-source','restart-denied',[item('restart-denied')]],'blocked');await f.rpc(f.bob.token,f.snapshots.b.id,'readOriginal',[before.captures[0].original.ref],'blocked');
});
