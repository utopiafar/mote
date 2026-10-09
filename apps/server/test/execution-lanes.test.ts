import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {ExecutionEngine,type ExecutionHandler} from '../src/execution-engine.js';

const handler:ExecutionHandler={kind:'generated.background',pool:'generated.lanes',concurrency:()=>64,validate:()=>true,execute:async()=>null,commit:()=>{}};
function lanes(engine:ExecutionEngine,background=2,interactive=1){engine.configurePool(handler.pool,{concurrency:{background:()=>background,interactive:()=>interactive},lane:step=>step.kind==='generated.interactive'?'interactive':'background'});}
function fixture(t:any){const directory=mkdtempSync(join(tmpdir(),'mote-execution-lanes-')),store=new Store(directory),engine=new ExecutionEngine(store);t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});return {directory,store,engine};}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('hard lane isolation preserves both capacities across database connections without idle borrowing',async t=>{
 const {directory,engine}=fixture(t),store2=new Store(directory),second=new ExecutionEngine(store2);lanes(engine);lanes(second);
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started:string[]=[];
 const execute:ExecutionHandler['execute']=async step=>{started.push(step.operationId);await held;return null;};
 for(const host of [engine,second]){host.register({...handler,execute});host.register({...handler,kind:'generated.interactive',execute});}
 t.after(async()=>{release();await second.close();store2.close();});
 const background=Array.from({length:4},(_,n)=>engine.enqueue('background-'+n,handler.kind,{lane:'interactive'}));
 const first=engine.tick();await turn();assert.equal(started.length,2,'background cannot borrow an idle interactive reservation');
 await second.tick();assert.equal(started.length,2);
 const interactive=Array.from({length:2},(_,n)=>second.enqueue('interactive-'+n,'generated.interactive',{}));
 const next=second.tick();await turn();assert.deepEqual(started,['background-0','background-1','interactive-0']);
 assert.deepEqual(second.poolSnapshot(handler.pool),{background:{limit:2,running:2,waiting:2},interactive:{limit:1,running:1,waiting:1}});
 assert.equal(second.get(interactive[1])!.attempts,0);assert.equal(engine.get(background[2])!.attempts,0);
 release();await Promise.all([first,next]);await engine.drain([...background,...interactive]);await second.drain([...background,...interactive]);
 assert.ok([...background,...interactive].every(id=>engine.get(id)!.state==='succeeded'));assert.equal(new Set(started).size,6);
});

test('continuous interactive arrivals cannot starve background work or consume its slots',async t=>{
 const {engine}=fixture(t);lanes(engine,1,1);let background=0,interactive=0,activeBackground=0,activeInteractive=0;const ids:string[]=[];
 engine.register({...handler,execute:async()=>{assert.equal(++activeBackground,1);await turn();background++;activeBackground--;return null;}});
 engine.register({...handler,kind:'generated.interactive',execute:async()=>{assert.equal(++activeInteractive,1);await turn();interactive++;activeInteractive--;if(interactive<120)ids.push(engine.enqueue('ask-'+interactive,'generated.interactive',{}));return null;}});
 for(let n=0;n<120;n++)ids.push(engine.enqueue('source-'+n,handler.kind,{}));ids.push(engine.enqueue('ask-0','generated.interactive',{}));
 await engine.drain(ids);
 assert.equal(background,120);assert.equal(interactive,120);assert.ok(ids.every(id=>engine.get(id)!.state==='succeeded'));
});

test('same-format shutdown and recovery retain lane identity and reject an uncooperative late result',async t=>{
 const {engine,store}=fixture(t);lanes(engine,1,1);let release!:()=>void,started!:()=>void,commits=0;
 const held=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve);
 engine.register({...handler,execute:async()=>{started();await held;return null;},commit:()=>{commits++;}});
 const id=engine.enqueue('generated-recovery',handler.kind,{lane:'interactive'}),run=engine.tick();await entered;await engine.close();await run;
 assert.equal(engine.get(id)!.state,'waiting');assert.equal(engine.get(id)!.error,'interrupted');
 const replacement=new ExecutionEngine(store);lanes(replacement,1,1);t.after(()=>replacement.close());replacement.register({...handler,commit:()=>{commits++;}});replacement.register({...handler,kind:'generated.interactive'});
 const ask=replacement.enqueue('generated-ask','generated.interactive',{});await replacement.drain([id,ask]);release();await turn();
 assert.equal(commits,1);assert.equal(replacement.get(id)!.attempts,2);assert.equal(replacement.get(ask)!.state,'succeeded');
 assert.ok(!String(store.db.prepare('SELECT input FROM execution_steps WHERE id=?').get(id)!.input).includes('background'),'lane is derived rather than added to durable input');
});

test('background retains its effective 32 limit while interactive has an independent reservation',async t=>{
 const {engine}=fixture(t);lanes(engine,64,2);let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 engine.register({...handler,execute:async()=>held});engine.register({...handler,kind:'generated.interactive',execute:async()=>held});
 const ids=[...Array.from({length:33},(_,n)=>engine.enqueue('background-'+n,handler.kind,{})),...Array.from({length:3},(_,n)=>engine.enqueue('ask-'+n,'generated.interactive',{}))];
 const running=engine.tick();await turn();assert.deepEqual(engine.poolSnapshot(handler.pool),{background:{limit:32,running:32,waiting:1},interactive:{limit:2,running:2,waiting:1}});
 release();await running;await engine.drain(ids);
});
