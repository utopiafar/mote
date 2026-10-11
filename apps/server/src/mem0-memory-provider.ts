import {fork,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {MemoryProviderError,type MemoryProvider,type MemoryProviderWrite,type MemoryProviderRead,type MemoryProviderRemove,type MemoryProviderSearch,type MemoryProviderNamespace,type MemoryProviderReceipt,type MemoryProviderHit,type MemoryProviderRecord,type MemoryProviderHealth} from './memory-provider-contract.js';
import type {Memory} from './memory-schema.js';
import {mem0RuntimeConfigSchema,type Mem0RuntimeConfig} from './mem0-memory-runtime.js';
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void};

/** Controlled service boundary, not a permission sandbox. Only the host can
 * create this facade or pass its write methods to migration/admission code. */
export class Mem0MemoryProvider implements MemoryProvider {
  private child?:ChildProcess;private starting?:Promise<void>;private next=0;private pending=new Map<number,Pending>();private closed=false;private closing?:Promise<void>;
  constructor(private readonly config:Mem0RuntimeConfig){mem0RuntimeConfigSchema.parse(config);}
  private fail(){for(const request of this.pending.values())request.reject(new MemoryProviderError('unknown_result','Memory worker exited; an external operation may require recovery'));this.pending.clear();this.child=undefined;this.starting=undefined;}
  private send<T>(method:string,input:unknown):Promise<T>{return new Promise<T>((resolve,reject)=>{const child=this.child;if(!child?.connected){reject(new MemoryProviderError('unavailable','Memory worker is unavailable'));return;}const id=++this.next;this.pending.set(id,{resolve,reject});child.send({id,method,input},error=>{if(error){this.pending.delete(id);reject(new MemoryProviderError('unknown_result','Memory worker transport failed'));}});});}
  private async start(){
    if(this.closed)throw new MemoryProviderError('closed','Memory provider is closed');if(this.starting)return this.starting;
    this.starting=(async()=>{
      const extension=import.meta.url.endsWith('.ts')?'ts':'js',execArgv=extension==='ts'?['--import',createRequire(import.meta.url).resolve('tsx')]:[];
      const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:join(this.config.directory,'sdk-home'),TMPDIR:process.env.TMPDIR,MEM0_TELEMETRY:'false',MEM0_DIR:join(this.config.directory,'sdk-state')};
      for(const key of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy','SystemRoot'])if(process.env[key])env[key]=process.env[key];
      const child=this.child=fork(new URL(`./mem0-memory-worker.${extension}`,import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],env,execArgv});
      child.on('message',(value:unknown)=>{const message=value as {id?:number;ok?:boolean;result?:unknown;error?:{code?:string;message?:string}};if(!Number.isSafeInteger(message?.id))return;const request=this.pending.get(message.id!);if(!request)return;this.pending.delete(message.id!);if(message.ok)request.resolve(message.result);else{const code=message.error?.code;request.reject(new MemoryProviderError(code==='conflict'||code==='invalid_record'||code==='unknown_result'||code==='closed'?code:'unavailable',message.error?.message??'Memory provider request failed'));}});
      child.once('error',()=>{if(this.child===child)this.fail();});child.once('exit',()=>{if(this.child===child)this.fail();});
      await this.send('initialize',this.config);
    })();return this.starting;
  }
  private async request<T>(method:string,input:unknown):Promise<T>{await this.start();if(this.closed)throw new MemoryProviderError('closed','Memory provider is closed');return this.send<T>(method,input);}
  put(input:MemoryProviderWrite){return this.request<MemoryProviderReceipt>('put',input);}
  read(input:MemoryProviderRead){return this.request<Memory|null>('read',input);}
  remove(input:MemoryProviderRemove){return this.request<MemoryProviderReceipt>('remove',input);}
  search(input:MemoryProviderSearch){return this.request<MemoryProviderHit[]>('search',input);}
  export(input:{namespace:MemoryProviderNamespace}){return this.request<MemoryProviderRecord[]>('export',input);}
  health(input:{namespace:MemoryProviderNamespace}){return this.request<MemoryProviderHealth>('health',input);}
  recover(input:{namespace:MemoryProviderNamespace}){return this.request<MemoryProviderHealth>('recover',input);}
  close():Promise<void>{
    if(this.closing)return this.closing;this.closed=true;const child=this.child;
    if(!child)return this.closing=Promise.resolve();
    this.closing=new Promise<void>(resolve=>{
      let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);this.fail();resolve();};
      // The deadline starts at close entry, including an SDK request blocked on
      // its embedding service. Waiting for the close RPC first can hang forever.
      const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
      child.once('exit',finish);child.once('error',finish);
      if(child.exitCode!==null||child.signalCode!==null){finish();return;}
      const terminate=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');};
      void this.send('close',null).then(terminate,terminate);
    });return this.closing;
  }
}
