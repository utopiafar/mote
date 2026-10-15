import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,lstatSync,rmSync,writeFileSync,mkdirSync,symlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../src/app.js';
import {registerUserRoute} from '../src/scope/app.js';
import {assertScopeStorage,openScopeStorage} from '../src/scope/storage.js';
import {ScopedServices} from '../src/scope/services.js';
import {LifecycleAuthority,type DomainLifecycle} from '../src/scope/lifecycle.js';
import {twoUsers} from './fixtures/two-users.js';

const temporary=(t:any)=>{const root=mkdtempSync(join(tmpdir(),'mote-scope-contract-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;};
const productionEntry=fileURLToPath(new URL('../src/index.ts',import.meta.url));
function snapshot(directory:string):unknown {return [lstatSync(directory).mode,readdirSync(directory).sort().map(name=>{const path=join(directory,name),stat=lstatSync(path);return [name,stat.mode,stat.isDirectory()?snapshot(path):readFileSync(path).toString('base64')];})];}
const lifecycle=(rows:Map<string,string>):DomainLifecycle=>({
  exportUser:async c=>({domain:'fixture',version:1,deploymentId:c.deploymentId,userId:c.userId,payload:rows.get(c.userId)}),
  deleteUser:async(c,operationId)=>{rows.delete(c.userId);return {status:'complete',operationId};},
  restoreUser:async(c,archive)=>{rows.set(c.userId,String(archive.payload));},
});

test('host contexts reject missing, forged, copied, foreign and revoked identities',async()=>{
  const fixture=twoUsers(),a=await fixture.authority.authenticate('generated-a');
  assert.ok(Object.isFrozen(a));assert.throws(()=>{(a as any).userId='generated-user-b';});
  await assert.rejects(fixture.authority.authenticate(undefined),{code:'identity_required'});
  await assert.rejects(fixture.authority.authenticate('old-owner-token'),{code:'invalid_identity'});
  for(const fake of [{...a},Object.create(a),structuredClone(a),undefined])assert.throws(()=>fixture.authority.assert(fake),{code:'invalid_identity'});
  assert.throws(()=>twoUsers().authority.assert(a),{code:'invalid_identity'});
  fixture.disabled.add(a.userId);assert.throws(()=>fixture.authority.assert(a),{code:'invalid_identity'});
});

test('service and lifecycle access stays with A/B, including admin A; disabled cleanup uses a purpose-limited host grant',async()=>{
  const fixture=twoUsers(),rows=new Map([['generated-user-a','synthetic A'],['generated-user-b','synthetic B']]);
  const control=new LifecycleAuthority('generated-deployment',{verify:async grant=>grant==='delete-a'?{deploymentId:'generated-deployment',userId:'generated-user-a',domain:'fixture',purpose:'delete',operationId:'delete-a'}:undefined,isCurrent:()=>true});
  const services=new ScopedServices(fixture.authority,control);
  services.registerUser('fixture',{scope:'user',create:c=>({read:()=>{fixture.authority.assert(c);return rows.get(c.userId);}}),lifecycle:lifecycle(rows)});
  services.registerInstance('resources',{scope:'instance',service:{version:1}});
  assert.throws(()=>services.registerUser('missing-scope',{} as any),{code:'undeclared_scope'});
  assert.throws(()=>services.registerUser('missing-lifecycle',{scope:'user',create:()=>({})} as any),{code:'undeclared_scope'});
  const a=await fixture.authority.authenticate('generated-a'),b=await fixture.authority.authenticate('generated-b');
  assert.equal(services.forUser(a).get<{read():string}>('fixture').read(),'synthetic A');
  assert.equal(services.forUser(b).get<{read():string}>('fixture').read(),'synthetic B');
  assert.throws(()=>services.forUser(a).get('resources'),{code:'scope_unavailable'});
  assert.throws(()=>services.forInstance(b),{statusCode:403});
  assert.deepEqual(services.forInstance(a).get('resources'),{version:1});
  const exported=await services.forUser(b).exportUser('fixture');
  assert.throws(()=>services.forUser(a).restoreUser('fixture',exported,'restore-a'),{statusCode:403});
  fixture.disabled.add(a.userId);assert.throws(()=>services.forUser(a),{code:'invalid_identity'});
  const grant=await control.authorize('delete-a');assert.throws(()=>services.forUser(grant as any),{code:'invalid_identity'});
  assert.throws(()=>services.forLifecycle({...grant}),{code:'invalid_identity'});
  assert.deepEqual(await services.forLifecycle(grant).run(),{status:'complete',operationId:'delete-a'});
  assert.equal(rows.has(a.userId),false);assert.equal(rows.get(b.userId),'synthetic B');
});

test('production builder defaults closed; old tokens and identity selectors cannot activate legacy services',async t=>{
  const directory=join(temporary(t),'fresh'),node=await buildApp({dataDir:directory});t.after(()=>node.app.close());
  assert.equal((await node.app.inject('/api/health')).json().storageEpoch,5);
  for(const headers of [{},{authorization:'Bearer old-owner-token'},{'x-user-id':'generated-user-a'}]){
    const response=await node.app.inject({url:'/api/captures',headers});assert.equal(response.statusCode,401);
  }
  for(const path of ['/api/login/exchange','/api/file-sync/batches','/api/plugins','/mcp'])assert.notEqual((await node.app.inject({method:'POST',url:path,payload:{}})).statusCode,200);
  assert.equal(readdirSync(directory).includes('access-token'),false);
  const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});t.after(()=>db.close());
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['scope_meta','auth_accounts','auth_credentials','auth_attempts','user_configuration_state','user_model_usage','user_configuration_restore_journal']);
});

test('real scoped HTTP registration binds identities, rejects spoofing and fences a late revoked response',async t=>{
  const directory=join(temporary(t),'fresh'),storage=openScopeStorage(directory);const id=storage.deploymentId;storage.close();
  const fixture=twoUsers(id),node=await buildApp({dataDir:directory},{verifier:fixture.verifier});t.after(()=>node.app.close());
  const rows=new Map([['generated-user-a','synthetic A'],['generated-user-b','synthetic B']]);
  node.services.registerUser('fixture',{scope:'user',create:()=>({}),lifecycle:lifecycle(rows)});
  let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  registerUserRoute(node,{scope:'user',method:'POST',url:'/api/fixture',service:'fixture',handle:async({context,request})=>{if((request.body as any)?.wait){entered();await waiting;}return {value:rows.get(context.userId)};}});
  assert.throws(()=>registerUserRoute(node,{method:'GET',url:'/api/undeclared',service:'fixture',handle:()=>1} as any),{code:'undeclared_scope'});
  for(const [token,value] of [['generated-a','synthetic A'],['generated-b','synthetic B']])assert.equal((await node.app.inject({method:'POST',url:'/api/fixture',headers:{authorization:'Bearer '+token,'x-mote-protocol-version':'2'},payload:{}})).json().value,value);
  for(const version of [undefined,'1','3'])assert.equal((await node.app.inject({method:'POST',url:'/api/fixture',headers:{authorization:'Bearer generated-a',...(version?{'x-mote-protocol-version':version}:{})},payload:{}})).statusCode,426);
  for(const attempt of [{url:'/api/fixture?userId=generated-user-b',payload:{}},{url:'/api/fixture',payload:{userId:'generated-user-b'}},{url:'/api/fixture',payload:{},headers:{'x-owner-id':'generated-user-b'}}]){
    const response=await node.app.inject({method:'POST',...attempt,headers:{authorization:'Bearer generated-a',...attempt.headers}});assert.equal(response.statusCode,401);
  }
  assert.equal((await node.app.inject({url:'/api/captures',headers:{authorization:'Bearer generated-a','x-mote-protocol-version':'2'}})).statusCode,503);
  const late=node.app.inject({method:'POST',url:'/api/fixture',headers:{authorization:'Bearer generated-a','x-mote-protocol-version':'2'},payload:{wait:true}});await started;fixture.disabled.add('generated-user-a');release();assert.equal((await late).statusCode,401);
});

test('old, unknown and malformed vaults are rejected without changing any bytes or modes',t=>{
  const root=temporary(t);
  for(const mode of ['epoch-4','wal','unknown','malformed']){
    const directory=join(root,mode);mkdirSync(directory);writeFileSync(join(directory,'preserved.txt'),'Generated retained original');
    if(mode==='malformed')writeFileSync(join(directory,'mote.sqlite'),'not sqlite');
    else if(mode!=='unknown'){
      const db=new DatabaseSync(join(directory,'mote.sqlite'));
      if(mode==='wal')db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('backend_epoch','4');");
      const before=snapshot(directory);assert.throws(()=>assertScopeStorage(directory),{code:'unsupported_vault'});assert.deepEqual(snapshot(directory),before);db.close();
    }
    const before=snapshot(directory);assert.throws(()=>openScopeStorage(directory),{code:'unsupported_vault'});assert.deepEqual(snapshot(directory),before);
  }
  const linked=join(root,'linked');symlinkSync(join(root,'epoch-4'),linked);assert.throws(()=>assertScopeStorage(linked),{code:'unsupported_vault'});
});

test('actual process startup rejects old vault before token, PID, config or directory writes',t=>{
  const root=temporary(t),directory=join(root,'vault');mkdirSync(directory);
  const db=new DatabaseSync(join(directory,'mote.sqlite'));db.exec('CREATE TABLE old_private_data(value TEXT)');db.close();
  const file=join(root,'config.yaml');writeFileSync(file,serializeConfigDocument({version:1,revision:0,storage:{dataDir:directory},server:{host:'127.0.0.1',port:47852}}));
  const before=snapshot(root);assert.throws(()=>execFileSync(process.execPath,['--import','tsx',productionEntry],{env:{...process.env,MOTE_CONFIG_FILE:file},stdio:'pipe',timeout:15000}),(error:any)=>{assert.match(error.stderr.toString(),/unsupported_vault/);return true;});assert.deepEqual(snapshot(root),before);
});

test('inconsistent current vault identity is rejected before permission or schema writes',async t=>{
  const directory=join(temporary(t),'invalid-current'),storage=openScopeStorage(directory);storage.close();
  const db=new DatabaseSync(join(directory,'mote.sqlite'));db.exec("UPDATE scope_meta SET deployment_id='invalid/deployment'");db.close();chmodSync(directory,0o755);
  const before=snapshot(directory);await assert.rejects(buildApp({dataDir:directory}),{code:'unsupported_vault'});assert.deepEqual(snapshot(directory),before);
});

test('actual production process serves health and rejects private requests without loading the fixture composition',async t=>{
  const root=mkdtempSync(join(tmpdir(),'mote-scope-process-')),directory=join(root,'vault');
  const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const file=join(root,'config.yaml');writeFileSync(file,serializeConfigDocument({version:1,revision:0,storage:{dataDir:directory},server:{host:'127.0.0.1',port}}));
  const child=spawn(process.execPath,['--import','tsx',productionEntry],{env:{...process.env,MOTE_CONFIG_FILE:file},stdio:['ignore','pipe','pipe']});
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  t.after(async()=>{child.kill('SIGTERM');await closed;rmSync(root,{recursive:true,force:true});});
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Generated production startup timed out')),10000);timer.unref();
    child.once('exit',code=>{clearTimeout(timer);reject(Error('Generated production startup exited '+code));});
    child.stdout.on('data',chunk=>{if(chunk.toString().includes('server.listening')){clearTimeout(timer);resolve();}});
  });
  const health=await fetch(`http://127.0.0.1:${port}/api/health`);assert.equal(health.status,200);assert.equal((await health.json() as any).mode,'multiuser-auth');
  const privateResponse=await fetch(`http://127.0.0.1:${port}/api/captures`,{headers:{authorization:'Bearer old-owner-token'}});assert.equal(privateResponse.status,401);
  assert.equal(readdirSync(directory).includes('access-token'),false);
  const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});try{assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name),['scope_meta','auth_accounts','auth_credentials','auth_attempts','user_configuration_state','user_model_usage','user_configuration_restore_journal']);}finally{db.close();}
});
