import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionHandler} from '../src/execution-engine.js';
async function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'mote-execution-engine-')),store=new Store(dir);let now=Date.now();
 const engine=new ExecutionEngine(store,()=>now);t.after(async()=>{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,store,engine,advance:(ms:number)=>{now+=ms;}};
}
const base:ExecutionHandler={kind:'fixture',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}};

test('one engine fills slots, fairly interleaves operations and keeps one step per immutable input',async t=>{
 const {engine}=await fixture(t),started:string[]=[],committed:string[]=[];let release!:()=>void,enter!:()=>void;
 const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 engine.register({...base,execute:async step=>{started.push(step.operationId);if(started.length===1){enter();await held;}return step.id;},commit:(step,value)=>{assert.equal(value,step.id);committed.push(step.id);}});
 const ids:string[]=[];for(let i=0;i<400;i++)ids.push(engine.enqueue(i<200?'bulk':'interactive','fixture',{n:i}));
 assert.equal(engine.enqueue('bulk','fixture',{n:0}),ids[0]);const run=engine.drain(ids);await entered;
 assert.equal(engine.get(ids[0])!.state,'running');release();await run;
 assert.equal(committed.length,400);assert.equal(new Set(committed).size,400);
 assert.deepEqual(started.slice(0,6),['bulk','interactive','bulk','interactive','bulk','interactive']);
 let count=0,cursor:number|undefined;do{const page=engine.list({limit:37,cursor});count+=page.items.length;cursor=page.nextCursor??undefined;}while(cursor);assert.equal(count,400);
});

test('cancel, stale inputs and failed commit transactions cannot save late results',async t=>{
 const {engine,store}=await fixture(t);store.db.exec('CREATE TABLE fixture_outputs(id TEXT PRIMARY KEY)');
 let release!:()=>void,enter!:()=>void,current=true;const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 engine.register({...base,validate:()=>current,execute:async()=>{enter();await held;return null;},commit:step=>{store.db.prepare('INSERT INTO fixture_outputs VALUES(?)').run(step.id);}});
 const id=engine.enqueue('cancelled','fixture',{}),run=engine.drain([id]);await entered;engine.cancel(id);await run;release();await new Promise(r=>setImmediate(r));
 assert.equal(engine.get(id)!.state,'cancelled');assert.equal(store.db.prepare('SELECT count(*) n FROM fixture_outputs').get()!.n,0);
 current=false;const stale=engine.enqueue('stale','fixture',{});await engine.drain([stale]);assert.equal(engine.get(stale)!.state,'stale');
 engine.register({...base,kind:'rollback',commit:step=>{store.db.prepare('INSERT INTO fixture_outputs VALUES(?)').run(step.id);throw new ExecutionFailure('permanent','bad_commit');}});
 const rollback=engine.enqueue('rollback','rollback',{});await engine.drain([rollback]);assert.equal(engine.get(rollback)!.state,'failed');assert.equal(store.db.prepare('SELECT count(*) n FROM fixture_outputs').get()!.n,0);
});

test('admission waits do not spend attempts; retry is bounded and persisted',async t=>{
 const {engine,advance}=await fixture(t);let blocked=true,calls=0;
 engine.register({...base,admit:()=>blocked?new ExecutionFailure('blocked','provider_not_configured'):undefined,execute:async()=>{calls++;throw new ExecutionFailure('transient','rate_limited',5000);}});
 const id=engine.enqueue('retry','fixture',{});await engine.drain([id]);assert.equal(engine.get(id)!.state,'blocked');assert.equal(engine.get(id)!.attempts,0);assert.equal(calls,0);
 blocked=false;engine.retry(id);await engine.drain([id]);assert.equal(calls,1);assert.equal(engine.get(id)!.state,'waiting');
 await engine.drain([id]);assert.equal(calls,1);
 for(let i=0;i<3;i++){advance(5001);await engine.drain([id]);}assert.equal(calls,4);assert.equal(engine.get(id)!.state,'failed');
 advance(100000);await engine.drain([id]);assert.equal(calls,4);
});

test('FTS deletion receipts cannot break failure, retry, cancellation or commit fences',async t=>{
 const {engine,store}=await fixture(t),db=store.db;
 db.exec("CREATE VIRTUAL TABLE fixture_fts USING fts5(text,content='',contentless_delete=1,tokenize='trigram')");
 const insert=db.prepare('INSERT INTO fixture_fts(rowid,text) VALUES(?,?)');
 for(let i=1;i<=3000;i++)insert.run(i,'Generated execution index '+i);
 let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 engine.register({...base,execute:async step=>{if(step.input.hold){entered();await new Promise(()=>{});}return null;},
  commit:()=>{db.prepare('DELETE FROM fixture_fts WHERE rowid=3').run();}});
 const failed=engine.enqueue('fts-failed','fixture',{});
 const cancelled=engine.enqueue('fts-cancelled','fixture',{hold:true});
 db.prepare('DELETE FROM fixture_fts WHERE rowid=1').run();db.prepare('DELETE FROM fixture_fts WHERE rowid=2').run();
 engine.fail(failed,'import_failed');assert.equal(engine.get(failed)?.state,'failed');
 engine.retry(failed);await engine.drain([failed]);assert.equal(engine.get(failed)?.state,'succeeded');
 await started;engine.cancel(cancelled);await engine.drain([cancelled]);assert.equal(engine.get(cancelled)?.state,'cancelled');
 assert.equal(db.isTransaction,false);
});

test('two database connections respect pool capacity, durable leases and fenced recovery',async t=>{
 const {dir,store,engine,advance}=await fixture(t),other=new Store(dir),second=new ExecutionEngine(other);
 let release!:()=>void,enter!:()=>void;const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);let calls=0;
 engine.register({...base,execute:async()=>{calls++;enter();await held;return null;}});second.register({...base,execute:async()=>{calls++;return null;}});
 t.after(async()=>{release();await second.close();other.close();});
 const a=engine.enqueue('a','fixture',{}),b=engine.enqueue('b','fixture',{}),run=engine.drain([a]);await entered;
 await second.tick();assert.equal(calls,1,'second connection exceeded the shared pool limit');
 // Simulate the dead process lease; its late commit must not win over recovery.
 store.db.prepare('UPDATE execution_steps SET lease_until=0 WHERE id=?').run(a);await second.drain([a,b]);assert.equal(calls,3);assert.equal(second.get(a)!.state,'succeeded');
 release();await run;assert.equal(engine.get(a)!.state,'succeeded');assert.equal(engine.get(a)!.attempts,2);
});


test('resource claims serialize shared evidence across connections without blocking independent work',async t=>{
 const {dir,engine}=await fixture(t),other=new Store(dir),second=new ExecutionEngine(other);let release!:()=>void,enter!:()=>void;
 const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r),calls:string[]=[];
 const handler={...base,concurrency:()=>3,resourceKeys:(step:any)=>[step.input.evidence]};
 engine.register({...handler,execute:async step=>{calls.push(step.operationId);enter();await held;return null;}});
 second.register({...handler,execute:async step=>{calls.push(step.operationId);return null;}});
 const a=engine.enqueue('held','fixture',{evidence:'shared'}),run=engine.drain([a]);await entered;
 const b=second.enqueue('same','fixture',{evidence:'shared'}),c=second.enqueue('independent','fixture',{evidence:'other'});
 await second.drain([b,c]);assert.deepEqual(calls,['held','independent']);assert.equal(second.get(b)!.attempts,0);
 release();await run;await engine.drain([b]);await second.drain([b]);assert.equal(second.get(b)!.state,'succeeded');assert.equal(calls.filter(id=>id==='same').length,1);
 await second.close();other.close();
});

test('an expired lease cannot commit even before another host reclaims it',async t=>{
 const {engine,advance}=await fixture(t);let calls=0;const committed:number[]=[];
 engine.register({...base,execute:async()=>{calls++;if(calls===1)advance(30001);return calls;},commit:(_step,result)=>{committed.push(Number(result));}});
 const id=engine.enqueue('expired-before-recovery','fixture',{});await engine.drain([id]);
 assert.deepEqual(committed,[2],'the expired first attempt must be discarded and recovered');
 assert.equal(engine.get(id)!.state,'succeeded');assert.equal(engine.get(id)!.attempts,2);
});

test('an expired lease cannot publish a permanent failure before recovery',async t=>{
 const {engine,advance}=await fixture(t);let calls=0;
 engine.register({...base,execute:async()=>{if(++calls===1){advance(30001);throw new ExecutionFailure('permanent','late_failure');}return null;}});
 const id=engine.enqueue('expired-failure','fixture',{});await engine.drain([id]);
 assert.equal(engine.get(id)!.state,'succeeded');assert.equal(engine.get(id)!.attempts,2);assert.equal(engine.get(id)!.error,undefined);
});

test('handler disposal interrupts local work and preserves queued, blocked and terminal tasks',async t=>{
 const {engine}=await fixture(t);let entered!:()=>void,release!:()=>void,signal!:AbortSignal,commits=0;
 const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 const unregister=engine.register({...base,execute:async(_step,current)=>{signal=current;entered();await held;},commit:()=>{commits++;}});
 const running=engine.enqueue('running','fixture',{}),queued=engine.enqueue('queued','fixture',{}),blocked=engine.enqueue('blocked','fixture',{}, {initial:{state:'blocked',attempts:0,availableAt:0,error:'model_missing'}}),cancelled=engine.enqueue('cancelled','fixture',{});
 engine.cancel(cancelled);const run=engine.tick();await started;await unregister();await run;
 assert.equal(signal.aborted,true);assert.equal(engine.closed,false);
 assert.equal(engine.get(running)!.state,'waiting');assert.equal(engine.get(running)!.error,'interrupted');
 assert.equal(engine.get(queued)!.state,'waiting');assert.equal(engine.get(queued)!.attempts,0);
 assert.equal(engine.get(blocked)!.state,'blocked');assert.equal(engine.get(blocked)!.error,'model_missing');
 assert.equal(engine.get(cancelled)!.state,'cancelled');release();await new Promise(resolve=>setImmediate(resolve));assert.equal(commits,0);
 engine.register({...base});await engine.drain([running,queued]);assert.equal(engine.get(running)!.state,'succeeded');assert.equal(engine.get(queued)!.state,'succeeded');
});
