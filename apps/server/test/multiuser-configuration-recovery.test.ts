import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync,existsSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {parse,stringify} from 'yaml';
import {z} from 'zod';
import {Configurations} from '../src/scope/configuration.js';
import {UserContextAuthority} from '../src/scope/context.js';
import {LifecycleAuthority} from '../src/scope/lifecycle.js';
import {defaultModelSettings} from '../src/model-settings.js';
import {ConfigService} from '../src/config-service.js';

const execute=promisify(execFile),deploymentId='synthetic-recovery-deployment',userId='synthetic-a',operationId='synthetic-restore';
const personal=(key:string)=>({profiles:[{id:'synthetic-profile',name:'Synthetic personal',settings:{...defaultModelSettings(),provider:'custom',protocol:'openai-completions',reasoningEffort:'auto',baseUrl:'https://synthetic.invalid/v1',model:'synthetic-model',apiKey:key}}],selections:{chat:{kind:'personal',id:'synthetic-profile'}}});

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-m04-recovery-')),database=join(directory,'recovery.sqlite');
  let epoch=0,revokeOnStage=false,db:DatabaseSync|undefined,manager:Configurations|undefined;
  const file=(id=userId)=>join(directory,'configuration','users',id,'mote.yaml');
  const stages=()=>{const path=join(directory,'configuration','users',userId);return existsSync(path)?readdirSync(path).filter(name=>name.startsWith('.restore-')):[];};
  const authority=new UserContextAuthority(deploymentId,{
    verify:async token=>({deploymentId,userId:token==='b'?'synthetic-b':userId,credentialId:'synthetic-'+token,authorizationEpoch:token==='new-a'?1:0,administrator:false}),
    isCurrent:identity=>identity.userId!==userId||identity.authorizationEpoch===epoch,
  });
  const revoked=new WeakSet<object>();
  const lifecycleAuthority=new LifecycleAuthority(deploymentId,{
    verify:async()=>({deploymentId,userId,domain:'configuration',operationId,purpose:'restore'}),
    isCurrent:context=>{if(revokeOnStage&&stages().length)revoked.add(context);return !revoked.has(context);},
  });
  const close=async()=>{await manager?.close();manager=undefined;db?.close();db=undefined;};
  const reopen=async()=>{db=new DatabaseSync(database);manager=await Configurations.open({directory,db,authority,lifecycleAuthority});};
  t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
  await reopen();
  return {directory,database,authority,lifecycleAuthority,file,stages,close,reopen,setEpoch:(value:number)=>{epoch=value;},setRevokeOnStage:(value:boolean)=>{revokeOnStage=value;},get manager(){return manager!;},get db(){return db!;}};
}

async function archiveFixture(t:TestContext){
  const f=await fixture(t),context=await f.authority.authenticate('old-a'),b=await f.authority.authenticate('b');
  const aService=f.manager.forUser(context);
  await aService.replace('models',personal('synthetic-A-original-key'),0);
  await f.manager.forUser(b).replace('models',personal('synthetic-B-original-key'),0);
  const lease=await aService.lease('chat','synthetic-original-operation');
  f.manager.recordUsage(lease,{status:'completed',durationMs:12,tokens:{requests:1,reportedRequests:1,inputTokens:8,outputTokens:3,totalTokens:11,cacheReadTokens:0,cacheWriteTokens:0}});
  const archive=await f.manager.lifecycle.exportUser(context),bBefore=readFileSync(f.file('synthetic-b'));
  await f.manager.lifecycle.deleteUser(context,'synthetic-delete');
  return {...f,get manager(){return f.manager;},get db(){return f.db;},archive,bBefore,context};
}

/** Kill a real restoring process after the file rename and directory fsync,
 * before the activation UPDATE can commit. SQLite rolls that transaction back
 * on reopen, while the independently committed journal and target survive. */
async function crashBeforeActivation(f:Awaited<ReturnType<typeof archiveFixture>>){
  const archivePath=join(f.directory,'synthetic-archive.json');writeFileSync(archivePath,JSON.stringify(f.archive),{mode:0o600});
  await f.close();
  const configurationUrl=new URL('../src/scope/configuration.ts',import.meta.url).href,contextUrl=new URL('../src/scope/context.ts',import.meta.url).href;
  const script=`
    import {readFileSync} from 'node:fs';
    import {DatabaseSync} from 'node:sqlite';
    import {Configurations} from ${JSON.stringify(configurationUrl)};
    import {UserContextAuthority} from ${JSON.stringify(contextUrl)};
    const db=new DatabaseSync(${JSON.stringify(f.database)});
    const authority=new UserContextAuthority(${JSON.stringify(deploymentId)},{verify:async()=>({deploymentId:${JSON.stringify(deploymentId)},userId:${JSON.stringify(userId)},credentialId:'synthetic-crash-session',authorizationEpoch:0,administrator:false}),isCurrent:()=>true});
    const manager=await Configurations.open({directory:${JSON.stringify(f.directory)},db,authority});
    db.function('synthetic_restore_crash',()=>{process.kill(process.pid,'SIGKILL');});
    db.exec("CREATE TEMP TRIGGER synthetic_restore_crash BEFORE UPDATE OF deleted ON user_configuration_state WHEN NEW.deleted=0 BEGIN SELECT synthetic_restore_crash(); END;");
    await manager.lifecycle.restoreUser(await authority.authenticate('synthetic-token'),JSON.parse(readFileSync(${JSON.stringify(archivePath)},'utf8')),${JSON.stringify(operationId)});
    throw Error('The synthetic restore must be killed before activation');
  `;
  await assert.rejects(execute(process.execPath,['--import','tsx','--input-type=module','-e',script],{timeout:15000,maxBuffer:4096}),error=>Boolean(error&&typeof error==='object'&&'signal' in error&&error.signal==='SIGKILL'));
  await f.reopen();
}

test('a real restore crash resumes the same credential-free journal and activates usage exactly once',async t=>{
  const f=await archiveFixture(t);await crashBeforeActivation(f);
  const pending=f.db.prepare('SELECT * FROM user_configuration_restore_journal WHERE user_id=?').get(userId)!;
  assert.equal(pending.operation_id,operationId);assert.match(String(pending.payload_hash),/^[a-f0-9]{64}$/);assert.match(String(pending.target_hash),/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(pending),/synthetic-[AB]-original-key/);
  assert.equal(f.db.prepare('SELECT deleted FROM user_configuration_state WHERE user_id=?').get(userId)!.deleted,1);
  assert.equal(parse(readFileSync(f.file(),'utf8')).models.profiles[0].settings.apiKey,'');
  const context=await f.authority.authenticate('old-a');
  await assert.rejects(f.manager.forUser(context).view(),{code:'invalid_identity'});
  await f.manager.lifecycle.restoreUser(context,f.archive,operationId);
  await f.manager.lifecycle.restoreUser(context,f.archive,operationId);
  const service=f.manager.forUser(context);
  assert.equal((await service.view()).revision,0);assert.equal(service.usage().total.runs,1);assert.equal(service.usage().total.totalTokens,11);
  await assert.rejects(service.lease('chat','synthetic-after-restore'),{code:'scope_unavailable'});
  assert.deepEqual(readFileSync(f.file('synthetic-b')),f.bBefore);assert.deepEqual(f.stages(),[]);
});

test('recovery rejects changed payloads, target hashes and cross-user links; deletion clears pending provenance',async t=>{
  const f=await archiveFixture(t);await crashBeforeActivation(f);
  const context=await f.authority.authenticate('old-a'),before=readFileSync(f.file()),changed=structuredClone(f.archive);
  (changed.payload as {document:{models:{profiles:{name:string}[]}}}).document.models.profiles[0]!.name='Changed archive';
  await assert.rejects(f.manager.lifecycle.restoreUser(context,changed,operationId),{code:'config_conflict'});
  await assert.rejects(f.manager.lifecycle.restoreUser(context,f.archive,'different-operation'),{code:'config_conflict'});
  assert.deepEqual(readFileSync(f.file()),before);
  const target=parse(before.toString());target.models.profiles[0].settings.apiKey='synthetic-foreign-key';writeFileSync(f.file(),stringify(target));
  const foreign=readFileSync(f.file());
  await assert.rejects(f.manager.lifecycle.restoreUser(context,f.archive,operationId),{code:'config_conflict'});
  assert.deepEqual(readFileSync(f.file()),foreign);assert.equal(f.db.prepare('SELECT deleted FROM user_configuration_state WHERE user_id=?').get(userId)!.deleted,1);
  unlinkSync(f.file());symlinkSync(f.file('synthetic-b'),f.file());
  await assert.rejects(f.manager.lifecycle.restoreUser(context,f.archive,operationId),{code:'config_conflict'});
  assert.deepEqual(readFileSync(f.file('synthetic-b')),f.bBefore);
  await f.manager.lifecycle.deleteUser(context,'synthetic-delete-pending');
  assert.equal(f.db.prepare('SELECT * FROM user_configuration_restore_journal WHERE user_id=?').get(userId),undefined);
  assert.equal(existsSync(f.file()),false);
  await f.manager.lifecycle.restoreUser(context,f.archive,operationId);
  await assert.rejects(f.manager.lifecycle.restoreUser(context,changed,operationId),{code:'config_conflict'});
  assert.equal(parse(readFileSync(f.file(),'utf8')).models.profiles[0].settings.apiKey,'');
});

test('an unknown credential-bearing YAML is never adopted as an interrupted restore',async t=>{
  const f=await archiveFixture(t),context=await f.authority.authenticate('old-a');
  const legacy={version:1,revision:0,models:personal('synthetic-unknown-old-key'),modelPrices:{items:[]}};
  // Simulate cleanup interrupted after its tombstone was committed.
  const directory=join(f.file(),'..');
  mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(f.file(),stringify(legacy),{mode:0o600});
  const unknown=readFileSync(f.file());
  await assert.rejects(f.manager.lifecycle.restoreUser(context,f.archive,operationId),{code:'config_conflict'});
  assert.deepEqual(readFileSync(f.file()),unknown);assert.equal(f.db.prepare('SELECT * FROM user_configuration_restore_journal WHERE user_id=?').get(userId),undefined);
});

test('revoking a restore grant cleans its stage, retains the fence and permits a newly authorized retry',async t=>{
  const f=await archiveFixture(t),grant=await f.lifecycleAuthority.authorize('synthetic-initial-grant');
  f.setRevokeOnStage(true);
  await assert.rejects(f.manager.lifecycle.restoreUser(grant,f.archive,operationId),{code:'invalid_identity'});
  assert.deepEqual(f.stages(),[]);assert.equal(existsSync(f.file()),false);
  const pending=f.db.prepare('SELECT * FROM user_configuration_restore_journal WHERE user_id=?').get(userId)!;
  assert.equal(pending.operation_id,operationId);assert.equal(pending.target_hash,null);
  assert.doesNotMatch(JSON.stringify(pending),/synthetic-[AB]-original-key/);
  assert.equal(f.db.prepare('SELECT deleted FROM user_configuration_state WHERE user_id=?').get(userId)!.deleted,1);
  f.setRevokeOnStage(false);
  await f.manager.lifecycle.restoreUser(await f.lifecycleAuthority.authorize('synthetic-replacement-grant'),f.archive,operationId);
  assert.equal(f.db.prepare('SELECT deleted FROM user_configuration_state WHERE user_id=?').get(userId)!.deleted,0);
  assert.deepEqual(f.stages(),[]);assert.deepEqual(readFileSync(f.file('synthetic-b')),f.bBefore);
});

test('a valid new epoch request survives the previous epoch initialization failure on its first attempt',async t=>{
  const f=await fixture(t);let release!:()=>void,entered!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  t.after(()=>{release();});
  f.manager.registerDomain('extension',()=>({id:'extension',schema:z.object({count:z.number()}),defaultValue:{count:0},resolve:value=>value,prepare:async()=>{entered();await wait;return {apply:()=>{}};}}));
  const old=f.manager.forUser(await f.authority.authenticate('old-a')).view();
  const oldRejected=assert.rejects(old,{code:'invalid_identity'});await started;
  f.setEpoch(1);const current=await f.authority.authenticate('new-a'),first=f.manager.forUser(current).view();
  release();await oldRejected;
  assert.doesNotThrow(()=>f.authority.assert(current));assert.equal((await first).revision,0);
});

test('parallel new epoch requests wait for a revoked transaction rollback before reopening its file',async t=>{
  const f=await fixture(t);let release!:()=>void,entered!:()=>void,closing!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),closingStarted=new Promise<void>(resolve=>{closing=resolve;});
  f.manager.registerDomain('extension',context=>({
    id:'extension',schema:z.object({limit:z.number()}).strict(),defaultValue:{limit:1},resolve:raw=>raw,
    prepare:(next:unknown)=>({
      apply:async()=>{if('credentialId' in context&&context.authorizationEpoch===0&&(next as {limit:number}).limit===99){entered();await wait;}},
      publish:()=>{},rollback:()=>{},
    }),
  }));
  const old=f.manager.forUser(await f.authority.authenticate('old-a'));await old.view();
  const pending=old.replace('extension',{limit:99},0),rejected=assert.rejects(pending,{code:'invalid_identity'});
  await started;
  const initialize=ConfigService.prototype.initialize,close=ConfigService.prototype.close;
  let released=false,reopenedBeforeDrain=0;
  t.mock.method(ConfigService.prototype,'initialize',function(this:ConfigService){
    if(this.path===f.file()&&!released)reopenedBeforeDrain++;
    return initialize.call(this);
  });
  t.mock.method(ConfigService.prototype,'close',function(this:ConfigService){
    if(this.path===f.file())closing();
    return close.call(this);
  });
  f.setEpoch(1);const current=f.manager.forUser(await f.authority.authenticate('new-a'));
  const first=current.view();await closingStarted;
  const second=current.view();await Promise.resolve();
  released=true;release();await rejected;
  const views=await Promise.all([first,second]);
  assert.equal(reopenedBeforeDrain,0,'A new epoch must not initialize from the old transaction candidate');
  for(const view of views){
    const extension=view.domains.find(domain=>domain.id==='extension')!;
    assert.deepEqual(extension.saved,{limit:1});assert.deepEqual(extension.effective,{limit:1});
    assert.equal(view.lastError,null);
  }
  assert.equal(parse(readFileSync(f.file(),'utf8')).extension.limit,1);
});
