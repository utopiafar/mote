import {channel} from 'node:diagnostics_channel';
import type {ChildProcess} from 'node:child_process';
import type {TestContext} from 'node:test';

type Worker={child:ChildProcess;events:string[];closed:Promise<void>};
/** Observe real subprocesses without substituting their decoder or IPC result. */
export function observeFormatWorkers(t:TestContext,onWorker?:(worker:Worker)=>void){
 const workers:Worker[]=[];
 let started!:(worker:Worker)=>void;
 const first=new Promise<Worker>(resolve=>{started=resolve;});
 const observe=({process:child}:{process:ChildProcess})=>child.once('spawn',()=>{
  if(!child.spawnargs.some(arg=>/[/\\]format-worker\.(ts|js)$/.test(arg)))return;
  let closed!:()=>void;
  const worker:Worker={child,events:[],closed:new Promise<void>(resolve=>{closed=resolve;})};
  child.on('message',()=>worker.events.push('message'));
  child.on('exit',()=>worker.events.push('exit'));
  child.once('close',()=>{worker.events.push('close');closed();});
  workers.push(worker);onWorker?.(worker);started(worker);
 });
 const diagnostics=channel('child_process');diagnostics.subscribe(observe);
 t.after(async()=>{
  diagnostics.unsubscribe(observe);
  for(const {child} of workers)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.all(workers.map(worker=>worker.closed));
 });
 return {workers,first};
}

/** An exited process can still have a buffered IPC reply. Control that platform
 * event ordering while retaining the real worker, bytes, validation and result. */
export function repliesAfterExit(t:TestContext,skip=0){
 let seen=0;
 return observeFormatWorkers(t,({child})=>{
  if(seen++<skip)return;
  const emit=child.emit.bind(child);let held:unknown[]|undefined,exited=false;
  t.mock.method(child,'emit',(event:string|symbol,...args:unknown[])=>{
   if(event==='message'&&!exited){held=args;return true;}
   if(event==='exit'){
    exited=true;const emitted=emit(event,...args);
    if(held){emit('message',...held);held=undefined;}
    return emitted;
   }
   return emit(event,...args);
  });
 });
}
