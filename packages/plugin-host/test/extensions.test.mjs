import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {singleExtension,collectionExtension,chainExtension} from '@mote/plugin-api';
import {PluginHost,ExtensionHost} from '@mote/plugin-host';

const lifecycle=()=>({prepare(){},start(){},quiesce(){},stop(){},dispose(){}});
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(t,beforeClose=()=>{},closeError){
  const host=new PluginHost({kind:'central',id:randomUUID()}),extensions=new ExtensionHost(host);
  t.after(async()=>{await beforeClose();try{await host.close();}catch(error){if(closeError)closeError(error);else throw error;}});
  const identity=(name,instance='one')=>({host:host.identity,packageId:'fixture.'+name,installationId:'build-'+name,instanceId:instance,activationId:randomUUID()});
  return {host,extensions,identity};
}
async function owner(f,contract,instance='one'){
  return f.extensions.define({identity:f.identity('interface',instance),contributionId:'domain-interface',contract});
}
async function provider(f,point,name,instance='one',order,control){
  const state={closed:false};
  const publication=point.contract.kind==='single'?{}:point.contract.kind==='ordered'?{name:'reader',order}:{name:'reader'};
  const installed=await f.extensions.provide(point,{identity:f.identity(name,instance),contributionId:'implementation',publication,
    factory(context){
      const db=new DatabaseSync(':memory:');state.db=db;
      context.scope.defer(()=>{db.close();state.closed=true;});
      db.exec('CREATE TABLE originals(text TEXT NOT NULL)');
      db.prepare('INSERT INTO originals(text) VALUES(?)').run(name);
      return {value:{
        async read(){
          if(control?.hold){control.entered.resolve();await control.release.promise;}
          return db.prepare('SELECT text FROM originals').get().text;
        },
        transform(input){return db.prepare('SELECT ? || text AS result FROM originals').get(input).result;},
      },lifecycle:lifecycle()};
    }});
  return {...installed,state};
}
async function client(f,point,binding,name,instance='one'){
  const state={closed:false};
  const handle=await f.extensions.single(point,binding,{identity:f.identity(name,instance),factory(context,lease){
    state.lease=lease;state.scope=context.scope;
    context.scope.defer(()=>{state.closed=true;});
    return lifecycle();
  }});
  return {handle,state};
}
const contains=(error,predicate)=>predicate(error)||(error instanceof AggregateError&&error.errors.some(item=>contains(item,predicate)));
async function cancelledSetup(t,mode,cleanupFailure){
  const entered=gate(),release=gate(),state={prepare:0,start:0,quiesce:0,stop:0,dispose:0};
  const f=fixture(t,()=>release.resolve(),error=>{assert.ok(cleanupFailure&&contains(error,item=>item===cleanupFailure));});
  const a=await owner(f,singleExtension('fixture.pending-reader','1'));
  let db;
  const installing=f.extensions.provide(a.point,{identity:f.identity('pending-provider'),contributionId:'implementation',publication:{},async factory(){
    db=new DatabaseSync(':memory:');db.exec('CREATE TABLE originals(text TEXT)');
    entered.resolve();await release.promise;
    // Deliberately lifecycle-owned, not scope.defer-owned: adoption must retain
    // these hooks even when the factory returns after cancellation.
    const owned={database:db,
      prepare(){state.prepare++;},start(){state.start++;},quiesce(){state.quiesce++;},stop(){state.stop++;},
      dispose(){this.database.close();state.dispose++;if(cleanupFailure)throw cleanupFailure;},
    };
    return {value:{read(){return db.prepare('SELECT text FROM originals').all();}},lifecycle:owned};
  }});
  const startup=installing.then(()=>({ok:true}),error=>({ok:false,error}));
  await entered.promise;
  const shutdown=(mode==='owner'?a.handle.close('uninstalled'):f.host.close()).then(()=>({ok:true}),error=>({ok:false,error}));
  release.resolve();
  const [started,closed]=await Promise.all([startup,shutdown]);
  t.after(()=>{if(db&&state.dispose===0)db.close();}); // Reclaim the generated fixture on an expected pre-fix red.
  return {f,state,db,started,closed};
}

test('cancelled provider setup retains lifecycle cleanup on interface unload and host shutdown',{timeout:5000},async t=>{
  for(const mode of ['owner','host']){
    const {f,state,db,started,closed}=await cancelledSetup(t,mode);
    assert.equal(started.ok,false);assert.ok(contains(started.error,error=>error?.code==='stale_scope'));
    assert.equal(closed.ok,true);
    assert.deepEqual(state,{prepare:0,start:0,quiesce:1,stop:1,dispose:1});
    assert.throws(()=>db.prepare('SELECT 1'));assert.equal(f.host.snapshot().contributions.length,0);
  }
});

test('cancelled provider setup preserves the startup fence and observable lifecycle cleanup failures',{timeout:5000},async t=>{
  const failure=Error('generated lifecycle cleanup failure');
  const {state,db,started,closed}=await cancelledSetup(t,'owner',failure);
  assert.equal(started.ok,false);assert.ok(contains(started.error,error=>error?.code==='stale_scope'));
  assert.equal(closed.ok,false);assert.ok(contains(closed.error,error=>error===failure));
  assert.ok(contains(started.error,error=>error===failure),'startup must retain cleanup failure with its primary fence error');
  assert.deepEqual(state,{prepare:0,start:0,quiesce:1,stop:1,dispose:1});
  assert.throws(()=>db.prepare('SELECT 1'));
});

test('explicit selection is unchanged by reverse installation; A defines a domain interface and two real consumers use B/C SQLite results',{timeout:5000},async t=>{
  for(const order of [['B','C'],['C','B']]){
    const f=fixture(t),a=await owner(f,singleExtension('fixture.original-reader','1')),providers={};
    for(const name of order){
      providers[name]=await provider(f,a.point,name);
      if(name===order[0])assert.throws(()=>f.extensions.single(a.point,undefined,{identity:f.identity('unbound'),factory:lifecycle}),{reason:'binding_required'});
    }
    assert.throws(()=>f.extensions.single(a.point,undefined,{identity:f.identity('ambiguous'),factory:lifecycle}),{reason:'ambiguous_binding'});
    const b=await client(f,a.point,providers.B.member.binding,'consumer','B'),c=await client(f,a.point,providers.C.member.binding,'consumer','C');
    assert.equal(b.handle.identity.packageId,c.handle.identity.packageId);assert.notEqual(b.handle.identity.instanceId,c.handle.identity.instanceId);
    assert.equal(await b.state.lease.value.read(),'B');assert.equal(await c.state.lease.value.read(),'C');
    await b.handle.close();assert.equal(b.state.closed,true);assert.equal(providers.B.state.closed,false);
    assert.throws(()=>b.state.lease.value.read(),{code:'stale_scope'});
    assert.equal(await c.state.lease.value.read(),'C');
    await f.host.close();assert.equal(providers.B.state.closed,true);assert.equal(providers.C.state.closed,true);
  }
});

test('collection names have contribution namespaces and chain order follows declared positions rather than installation or selection order',{timeout:5000},async t=>{
  const f=fixture(t),collection=await owner(f,collectionExtension('fixture.readers','1'),'collection');
  const b=await provider(f,collection.point,'B','collection'),c=await provider(f,collection.point,'C','collection');
  let collected;
  await f.extensions.collection(collection.point,[c.member.binding,b.member.binding],{identity:f.identity('collection-client'),async factory(_context,members){
    collected=await Promise.all(members.map(async member=>({name:member.name,packageId:member.namespace.scope.packageId,result:await member.lease.value.read()})));
    return lifecycle();
  }});
  assert.deepEqual(collected,[{name:'reader',packageId:'fixture.B',result:'B'},{name:'reader',packageId:'fixture.C',result:'C'}]);
  assert.throws(()=>f.extensions.single(collection.point,b.member.binding,{identity:f.identity('wrong-mode'),factory:lifecycle}),{reason:'invalid_selection'});
  const chain=await owner(f,chainExtension('fixture.transformers','1'),'chain');
  const late=await provider(f,chain.point,'B','chain',20),early=await provider(f,chain.point,'C','chain',10);
  let result='',steps;
  await f.extensions.chain(chain.point,[late.member.binding,early.member.binding],{identity:f.identity('chain-client'),factory(_context,members){
    steps=members.map(member=>({order:member.order,packageId:member.namespace.scope.packageId}));
    for(const member of members)result=member.lease.value.transform(result);
    return lifecycle();
  }});
  assert.deepEqual(steps,[{order:10,packageId:'fixture.C'},{order:20,packageId:'fixture.B'}]);assert.equal(result,'CB');
  assert.throws(()=>f.extensions.chain(chain.point,[late.member.binding,late.member.binding],{identity:f.identity('duplicate-step'),factory:lifecycle}),{reason:'invalid_selection'});
  const tied=await owner(f,chainExtension('fixture.tied-transformers','1'),'tied-chain');
  const tiedC=await provider(f,tied.point,'C','tied-chain',10),tiedB=await provider(f,tied.point,'B','tied-chain',10);
  let tiedResult='';
  await f.extensions.chain(tied.point,[tiedC.member.binding,tiedB.member.binding],{identity:f.identity('tied-chain-client'),factory(_context,members){
    for(const member of members)tiedResult=member.lease.value.transform(tiedResult);
    return lifecycle();
  }});
  assert.equal(tiedResult,'BC','equal positions use exact provider identity, never install or input order');
});

test('revoking B fences and drains a real in-flight read, releases its required consumer, and keeps sibling C callable without fallback',{timeout:5000},async t=>{
  const control={hold:false,entered:gate(),release:gate()};
  const f=fixture(t,()=>control.release.resolve()),a=await owner(f,singleExtension('fixture.revocable-reader','1'));
  const b=await provider(f,a.point,'B','one',undefined,control),c=await provider(f,a.point,'C');
  const x=await client(f,a.point,b.member.binding,'consumer-B'),y=await client(f,a.point,c.member.binding,'consumer-C');
  const committed=[];control.hold=true;
  const pending=x.state.lease.value.read().then(value=>{x.state.scope.assertCurrent();committed.push(value);});
  const rejected=assert.rejects(pending,error=>['stale_scope','dependency_unavailable'].includes(error.code));
  await control.entered.promise;
  const closing=b.handle.close('revoked');
  t.after(()=>{control.release.resolve();return closing;});
  assert.equal(x.handle.signal.aborted,true);assert.equal(y.handle.signal.aborted,false);
  assert.equal(b.state.closed,false,'provider DB must remain open until accepted read settles');
  assert.equal(await y.state.lease.value.read(),'C');
  assert.throws(()=>f.extensions.single(a.point,b.member.binding,{identity:f.identity('stale-selection'),factory:lifecycle}),{reason:'unknown_member'});
  control.release.resolve();await rejected;await closing;
  assert.deepEqual(committed,[]);assert.equal(x.state.closed,true);assert.equal(b.state.closed,true);
  assert.throws(()=>b.state.db.prepare('SELECT 1'));
  assert.equal(c.state.closed,false);assert.equal(await y.state.lease.value.read(),'C');
  const replacement=await provider(f,a.point,'B');
  assert.notEqual(replacement.member.binding.provider.scope.activationId,b.member.binding.provider.scope.activationId);
  assert.throws(()=>f.extensions.single(a.point,b.member.binding,{identity:f.identity('old-activation'),factory:lifecycle}),{reason:'unknown_member'});
  const fresh=await client(f,a.point,replacement.member.binding,'new-B-consumer');
  assert.equal(await fresh.state.lease.value.read(),'B');
});

test('unloading interface A closes its actual required graph while another A instance and its providers survive',{timeout:5000},async t=>{
  const f=fixture(t),contract=singleExtension('fixture.instance-reader','1');
  const a1=await owner(f,contract,'one'),a2=await owner(f,contract,'two');
  const b1=await provider(f,a1.point,'B','one'),c1=await provider(f,a1.point,'C','one');
  const b2=await provider(f,a2.point,'B','two'),c2=await provider(f,a2.point,'C','two');
  const x=await client(f,a1.point,b1.member.binding,'consumer','one'),y=await client(f,a2.point,c2.member.binding,'consumer','two');
  assert.throws(()=>f.extensions.single(a1.point,c2.member.binding,{identity:f.identity('cross-instance'),factory:lifecycle}),{reason:'unknown_member'});
  await a1.handle.close('uninstalled');
  assert.equal(x.handle.signal.aborted,true);assert.equal(x.state.closed,true);
  assert.equal(b1.state.closed,true);assert.equal(c1.state.closed,true);
  assert.throws(()=>f.extensions.members(a1.point),{reason:'unknown_member'});
  assert.equal(y.handle.signal.aborted,false);assert.equal(b2.state.closed,false);assert.equal(c2.state.closed,false);
  assert.equal(await y.state.lease.value.read(),'C');assert.equal(f.extensions.members(a2.point).length,2);
});

test('public types preserve the domain port and reject wrong cardinality, publication and implementation shapes',{timeout:10000},()=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-extension-types-'));
  try{
    const modules=join(directory,'node_modules','@mote');mkdirSync(modules,{recursive:true});
    symlinkSync(fileURLToPath(new URL('../../plugin-api/',import.meta.url)),join(modules,'plugin-api'),'dir');
    symlinkSync(fileURLToPath(new URL('../',import.meta.url)),join(modules,'plugin-host'),'dir');
    const file=join(directory,'consumer.mts');
    writeFileSync(file,`
import {singleExtension,type ExtensionPoint,type ExtensionPublication,type ScopeIdentity,type ServiceBinding} from '@mote/plugin-api';
import type {ExtensionHost} from '@mote/plugin-host';
interface Reader {read():Promise<string>}
declare const host:ExtensionHost,identity:ScopeIdentity,binding:ServiceBinding;
const contract=singleExtension<Reader>('fixture.typed-reader','1');
const point:ExtensionPoint<Reader,'single'>={contract,binding};
const life=()=>({prepare(){},start(){},quiesce(){},stop(){},dispose(){}});
host.single(point,binding,{identity,factory(_context,lease){const result:Promise<string>=lease.value.read();void result;return life();}});
host.provide(point,{identity,contributionId:'reader',publication:{},factory(){return {value:{async read(){return 'generated';}},lifecycle:life()};}});
// @ts-expect-error Singles require an explicit binding even with one provider.
host.single(point,undefined,{identity,factory:life});
// @ts-expect-error A single point is not a collection.
host.collection(point,[binding],{identity,factory:life});
// @ts-expect-error Singles have no collection-name policy.
const publication:ExtensionPublication<'single'>={name:'reader'};
// @ts-expect-error The implementation must satisfy A's actual Reader contract.
host.provide(point,{identity,contributionId:'reader',publication:{},factory(){return {value:{read(){return 42;}},lifecycle:life()};}});
`);
    const program=ts.createProgram([file],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:[],lib:['lib.es2023.d.ts','lib.dom.d.ts']});
    const diagnostics=ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map(diagnostic=>ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n')),[]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
