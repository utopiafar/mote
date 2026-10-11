import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {StoreError} from './store.js';

export interface PluginRuntime {
  call(method:'health'|'put'|'read'|'remove'|'search'|'export',params:unknown,signal?:AbortSignal):Promise<unknown>;
  close():Promise<void>;
}
/** JSON RPC transport. Neither credentials nor provider prose are emitted into
 * diagnostics, and query agents never receive this control/write interface. */
export class WorkerPluginRuntime implements PluginRuntime {
  private process:ChildProcessWithoutNullStreams;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>();
  private closed=false;
  private initialized:Promise<unknown>;
  private closing?:Promise<void>;
  constructor(entry:string,configuration:Record<string,unknown>,cwd:string){
    this.process=spawn(process.execPath,[fileURLToPath(new URL('./plugin-worker.mjs',import.meta.url))],{cwd,env:{PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR},stdio:['pipe','pipe','pipe']});
    this.process.stderr.resume();
    const reader=createInterface({input:this.process.stdout,crlfDelay:Infinity});
    reader.on('line',line=>{let result:{id:number;result?:unknown;error?:unknown};try{result=JSON.parse(line);}catch{return;}
      const pending=this.pending.get(result.id);if(!pending)return;this.pending.delete(result.id);result.error?pending.reject(new StoreError('Plugin worker reported an operation failure',502)):pending.resolve(result.result);
    });
    this.process.on('error',()=>this.fail());this.process.on('exit',()=>this.fail());
    this.initialized=this.request('initialize',{entry,configuration});
  }
  private fail(){this.closed=true;for(const pending of this.pending.values())pending.reject(new StoreError('Plugin worker is unavailable; recover its pending operation before retrying',503));this.pending.clear();}
  private request(method:string,params:unknown){
    if(this.closed)return Promise.reject(new StoreError('Plugin worker is closed',503));
    const id=++this.sequence;return new Promise<unknown>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.process.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){this.pending.delete(id);reject(new StoreError('Plugin worker transport failed',503));}});});
  }
  async call(method:'health'|'put'|'read'|'remove'|'search'|'export',params:unknown,signal?:AbortSignal){
    await this.initialized;if(signal?.aborted)throw new StoreError('Plugin operation was revoked',409);
    // Cancellation fences local publication. A submitted remote mutation still
    // needs reconciliation; closing a transport never proves remote rollback.
    const result=await this.request(method,params);if(signal?.aborted)throw new StoreError('Plugin result arrived after revocation; reconciliation is required',409);return result;
  }
  async close(){if(this.closing)return this.closing;if(this.process.exitCode!==null||this.process.signalCode!==null)return;this.process.stdin.end();this.closing=new Promise<void>(resolve=>{
    const deadline=setTimeout(()=>this.process.kill('SIGKILL'),5000);deadline.unref();
    this.process.once('exit',()=>{clearTimeout(deadline);resolve();});
  });return this.closing;}
}
