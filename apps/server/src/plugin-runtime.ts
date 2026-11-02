import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {StoreError} from './store.js';
import {serviceContract,type ServiceBinding,type ScopeIdentity,type ServiceLease} from '@mote/plugin-api/contracts';
import type {PluginHost,PluginHandle} from '@mote/plugin-host';

export interface PluginRuntime {
  ready?(signal?:AbortSignal):Promise<unknown>;
  call(method:'health'|'put'|'read'|'remove'|'search'|'export',params:unknown,signal?:AbortSignal):Promise<unknown>;
  close():Promise<void>;
}
/** JSON RPC transport. Neither credentials nor provider prose are emitted into
 * diagnostics, and query agents never receive this control/write interface. */
export class WorkerPluginRuntime implements PluginRuntime {
  private process:ChildProcessWithoutNullStreams;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:unknown)=>void;dispose:()=>void}>();
  private closed=false;
  private initialized:Promise<unknown>;
  private exited:Promise<void>;
  private closing?:Promise<void>;
  constructor(entry:string,configuration:Record<string,unknown>,cwd:string){
    this.process=spawn(process.execPath,[fileURLToPath(new URL('./plugin-worker.mjs',import.meta.url))],{cwd,env:{PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR},stdio:['pipe','pipe','pipe']});
    this.exited=new Promise(resolve=>this.process.once('close',()=>resolve()));
    this.process.stderr.resume();
    const reader=createInterface({input:this.process.stdout,crlfDelay:Infinity});
    reader.on('line',line=>{let result:{id:number;result?:unknown;error?:unknown};try{result=JSON.parse(line);}catch{return;}
      const pending=this.pending.get(result.id);if(!pending)return;this.pending.delete(result.id);pending.dispose();result.error?pending.reject(new StoreError('Plugin worker reported an operation failure',502)):pending.resolve(result.result);
    });
    reader.on('close',()=>this.fail());
    this.process.stdin.on('error',()=>this.fail());
    this.process.on('error',()=>this.fail());this.process.on('exit',()=>this.fail());
    this.initialized=this.request('initialize',{entry,configuration});
    // Initialization can fail before the first caller has awaited it.
    void this.initialized.catch(()=>{});
  }
  private fail(){this.closed=true;for(const pending of this.pending.values()){pending.dispose();pending.reject(new StoreError('Plugin worker is unavailable; recover its pending operation before retrying',503));}this.pending.clear();}
  private request(method:string,params:unknown,signal?:AbortSignal){
    if(this.closed)return Promise.reject(new StoreError('Plugin worker is closed',503));
    if(signal?.aborted)return Promise.reject(new StoreError('Plugin operation was revoked',409));
    const id=++this.sequence;return new Promise<unknown>((resolve,reject)=>{
      const abort=()=>{
        const pending=this.pending.get(id);if(!pending)return;
        this.pending.delete(id);pending.dispose();
        // The plugin can stop cooperative work. A mutation already submitted
        // still needs reconciliation; cancellation does not prove rollback.
        reject(new StoreError('Plugin operation was revoked; reconciliation is required before retrying a submitted mutation',409));
        try{this.process.stdin.write(JSON.stringify({id,method:'cancel'})+'\n',error=>{if(error)this.fail();});}catch{this.fail();}
      };
      this.pending.set(id,{resolve,reject,dispose:()=>signal?.removeEventListener('abort',abort)});
      signal?.addEventListener('abort',abort,{once:true});
      try{this.process.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error)this.fail();});}catch{this.fail();}
    });
  }
  private waitUntilInitialized(signal?:AbortSignal):Promise<unknown>{
    if(signal?.aborted)return Promise.reject(new StoreError('Plugin operation was revoked',409));
    if(!signal)return this.initialized;
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(new StoreError('Plugin operation was revoked',409));};
      signal.addEventListener('abort',abort,{once:true});
      void this.initialized.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    });
  }
  ready(signal?:AbortSignal){return this.waitUntilInitialized(signal);}
  async call(method:'health'|'put'|'read'|'remove'|'search'|'export',params:unknown,signal?:AbortSignal){
    if(this.closed)throw new StoreError('Plugin worker is closed',503);
    await this.waitUntilInitialized(signal);if(signal?.aborted)throw new StoreError('Plugin operation was revoked',409);
    // Cancellation fences local publication. A submitted remote mutation still
    // needs reconciliation; closing a transport never proves remote rollback.
    const result=await this.request(method,params,signal);if(signal?.aborted)throw new StoreError('Plugin result arrived after revocation; reconciliation is required',409);return result;
  }
  async close(){if(this.closing)return this.closing;this.fail();this.closing=(async()=>{
    const deadline=setTimeout(()=>this.process.kill('SIGKILL'),5000);deadline.unref();
    this.process.stdin.end();
    try{await this.exited;}finally{clearTimeout(deadline);}
  })();return this.closing;}
}

const workerPort=serviceContract<Pick<PluginRuntime,'call'>>('mote.plugin.worker-runtime','1');
/** Local admission refusal is not evidence of transport loss. Accepted calls
 * retain their scope until the owner finishes graceful draining. */
class RuntimeAdmissionError extends StoreError {
  constructor(){super('Plugin runtime is quiescing',503);this.name='RuntimeAdmissionError';}
}
/** A worker transport is owned by a child of the existing host. The required
 * control binding pins its owner; unloading control revokes every child before
 * waiting for cleanup. This is a lifetime boundary, never a sandbox or grant. */
export class HostedPluginRuntime implements PluginRuntime {
  private readonly initialized:Promise<void>;
  private readonly startupCancellation=new AbortController();
  private transportClose?:()=>Promise<void>;
  private handle?:PluginHandle;
  private lease?:ServiceLease<Pick<PluginRuntime,'call'>>;
  private closed=false;
  private closing?:Promise<void>;
  constructor(host:PluginHost,identity:ScopeIdentity,owner:ServiceBinding,create:()=>PluginRuntime){
    const thisOwner=this;
    this.initialized=(async()=>{
      this.handle=await host.install({identity,contributions:[{id:'worker-runtime',apiVersion:'1'}],requires:[owner],factory:context=>{
        let runtime:PluginRuntime;
        return {
          async prepare(){
            thisOwner.startupCancellation.signal.throwIfAborted();runtime=create();
            let closing:Promise<void>|undefined;
            thisOwner.transportClose=()=>closing??=Promise.resolve().then(()=>runtime.close());
            context.scope.defer(thisOwner.transportClose);
            await runtime.ready?.(AbortSignal.any([context.scope.signal,thisOwner.startupCancellation.signal]));
            thisOwner.startupCancellation.signal.throwIfAborted();context.scope.assertCurrent();
          },
          start(){context.provide('worker-runtime',workerPort,{call:async(method,params,signal)=>{
            const accepted=await context.scope.run(async scopeSignal=>({value:await runtime.call(method,params,AbortSignal.any([scopeSignal,...(signal?[signal]:[])]))}));
            if(!accepted)throw new RuntimeAdmissionError();return accepted.value;
          }});},
          quiesce(){},stop(){},dispose(){},
        };
      }});
      if(this.closed){await this.handle.close('shutdown');throw new StoreError('Plugin runtime is closing',503);}
      this.lease=await host.acquire(workerPort,{service:workerPort,provider:{scope:identity,contributionId:'worker-runtime'},revision:0});
    })();
    void this.initialized.catch(()=>{});
  }
  async ready(signal?:AbortSignal){
    if(signal?.aborted)throw new StoreError('Plugin operation was revoked',409);
    if(signal)await new Promise<void>((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(new StoreError('Plugin operation was revoked',409));};
      signal.addEventListener('abort',abort,{once:true});
      void this.initialized.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});
    });else await this.initialized;
    signal?.throwIfAborted();this.lease!.assertCurrent();
  }
  async call(...args:Parameters<PluginRuntime['call']>){
    if(this.closed)throw new StoreError('Plugin runtime is closing',503);
    await this.ready(args[2]);
    try{return await this.lease!.value.call(...args);}catch(error){
      if(error instanceof StoreError&&error.statusCode===503&&!(error instanceof RuntimeAdmissionError)){
        this.closed=true;this.closing=this.handle!.close('revoked');void this.closing.catch(()=>{});
      }
      throw error;
    }
  }
  close(){
    if(this.closing)return this.closing;
    // Publish before abort listeners can reenter. Starting transport cleanup
    // before joining install reaches its existing physical shutdown deadline,
    // even when the plugin factory never finishes initializing.
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    this.closing=new Promise<void>((done,failed)=>{resolve=done;reject=failed;});this.closed=true;
    const handle=this.handle,stopping=handle?.close('shutdown');
    this.startupCancellation.abort(new StoreError('Plugin runtime is closing',503));
    const transport=this.transportClose?.();
    void (async()=>{
      const errors:unknown[]=[];
      const results=await Promise.allSettled([...(transport?[transport]:[]),...(stopping?[stopping]:[])]);
      errors.push(...results.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
      await this.initialized.catch(()=>{}); // The caller retains startup failure.
      try{await this.lease?.release();}catch(error){errors.push(error);}
      if(this.handle!==handle)try{await this.handle?.close('shutdown');}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'Hosted plugin disposal failed');
    })().then(resolve,reject);
    return this.closing;
  }
}
