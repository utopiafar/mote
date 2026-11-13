import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {connect} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import type {MediaRole,MediaAssetStatus} from '@mote/shared';
import {prepareNativeMediaRuntime,mediaRoleSupported,mediaWorkerLaunch,mediaWorkerEnvironment,spawnMediaProcess,type MediaRuntimeOptions,type MediaProcess,type NativeMediaRole} from './media-native-runtime.mjs';
import {mediaModelHealth,mediaRoleEndpoint,type MediaConfiguration} from './media-configuration.js';
import {StoreError} from './store.js';

type State='idle'|'queued'|'dependencies'|'verifying_dependencies'|'models'|'starting'|'ready'|'failed'|'cancelled'|'unsupported';
type Job={id:string;role:MediaRole;state:State;error?:string;startedAt:string;controller:AbortController;done:Promise<void>};
/** Structural asset port consumes CORE-00's role contract. CORE-01 owns its
 * implementation, including installation verification and catalog readiness. */
export interface MediaPreparationAssets {
  readonly root:string;
  ready(role:MediaRole):boolean;
  status(role:MediaRole):{role:MediaRole;state:string;version:string;bytes:number;totalBytes:number;source:string;error?:string};
  installAsync(role:MediaRole,source?:'auto'|'official'|'mirror',signal?:AbortSignal):Promise<void>;
}
type Prepared={python:string};
type Options={runtime:'native'|'docker'|'unknown';media:MediaConfiguration;assets:MediaPreparationAssets;repository?:string;prepare?:(options:MediaRuntimeOptions&{signal:AbortSignal})=>Promise<Prepared>;fetch?:typeof fetch;startupTimeoutMs?:number};
const roles=['ocr','dialogue','speaker-wespeaker','local-image'] as const;
const active=(state:State)=>['queued','dependencies','verifying_dependencies','models','starting'].includes(state);
const portOccupied=(port:number)=>new Promise<boolean>(resolve=>{
  const socket=connect({host:'127.0.0.1',port});
  const finish=(value:boolean)=>{socket.destroy();resolve(value);};
  socket.setTimeout(1000,()=>finish(true));socket.once('connect',()=>finish(true));socket.once('error',error=>finish((error as NodeJS.ErrnoException).code!=='ECONNREFUSED'));
});
/** One Central lifecycle owns Native process groups; sidecars stay deployment
 * owned. Role directories are resources, not new PluginHost runtimes. */
export class MediaPreparation {
  private jobs=new Map<MediaRole,Job>();
  private workers=new Map<NativeMediaRole,MediaProcess>();
  private stopping=new Map<MediaRole,Promise<void>>();
  private epochs=new Map<MediaRole,number>();
  private closing=false;
  private changed=false;
  private abort=new AbortController();
  private repository:string;
  readonly directory:string;
  constructor(private options:Options){
    this.repository=options.repository??resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
    this.directory=join(options.assets.root,'runtime');
  }
  private model(role:MediaRole){
    try{return this.options.assets.status(role);}
    catch{return {role,state:'not_installed',version:'unavailable',bytes:0,totalBytes:0,source:''} satisfies MediaAssetStatus;}
  }
  private unsupported(role:MediaRole){
    const {runtime,media}=this.options;
    if(this.changed)return 'configuration_changed';
    if(runtime==='unknown')return 'runtime_unknown';
    if(!media.workerToken)return 'worker_auth_missing';
    if(role==='speaker-wespeaker')return 'worker_unsupported';
    if(!mediaRoleSupported(role))return 'platform_unsupported';
    if(role==='local-image'&&runtime!=='native')return 'platform_unsupported';
    if(this.model(role).version==='unavailable')return 'model_role_unavailable';
    if(runtime==='native'){
      if(process.platform==='linux'&&!(process.report?.getReport() as {header?:{glibcVersionRuntime?:string}}).header?.glibcVersionRuntime)return 'platform_unsupported';
      const port=role==='ocr'?media.ocrPort:role==='dialogue'?media.asrPort:media.localImagePort??9011;
      const path=role==='ocr'?'/ocr':role==='dialogue'?'/transcribe':'/v1/interpret';
      if(mediaRoleEndpoint(role,media)!==`http://127.0.0.1:${port}${path}`)return 'external_worker';
    }
    return undefined;
  }
  private async health(role:MediaRole,signal?:AbortSignal):Promise<ReturnType<typeof mediaModelHealth>>{
    if(this.closing||this.unsupported(role))return {ready:false};
    const epoch=this.epochs.get(role),{media}=this.options;
    const url=new URL(mediaRoleEndpoint(role,media));url.pathname='/health';url.search='';url.hash='';
    try{
      const requestSignal=AbortSignal.any([this.abort.signal,...(signal?[signal]:[]),AbortSignal.timeout(2500)]);
      const response=await(this.options.fetch??fetch)(url,{headers:{Authorization:`Bearer ${media.workerToken}`},redirect:'error',signal:requestSignal});
      if(!response.ok||!response.body){await response.body?.cancel();return {ready:false};}
      const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();
      try{for(;;){requestSignal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64*1024)throw Error('media.runtime.health_limit');chunks.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      requestSignal.throwIfAborted();
      if(this.closing||this.changed||this.epochs.get(role)!==epoch)return {ready:false};
      return mediaModelHealth(role,JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }catch{return {ready:false};}
  }
  private owned(role:MediaRole){
    const worker=this.workers.get(role as NativeMediaRole);
    return worker&&worker.child.exitCode===null&&worker.child.signalCode===null&&!worker.error;
  }
  async status(role:MediaRole){
    const before=this.model(role),health:ReturnType<typeof mediaModelHealth>=before.state==='ready'&&!this.unsupported(role)?await this.health(role):{ready:false};
    // Read job and ownership AFTER health: cancellation/stop/configuration may
    // have completed while an authenticated response was still in flight.
    const unsupported=this.unsupported(role),model=this.model(role),job=this.jobs.get(role),runtimeReady=!this.closing&&!unsupported&&model.state==='ready'&&model.version===before.version&&!this.stopping.has(role)&&health.ready&&(this.options.runtime==='docker'||Boolean(this.owned(role)));
    return {role,state:unsupported?'unsupported':job?.state==='ready'&&!runtimeReady?'failed':job?.state??(runtimeReady?'ready':'idle'),id:job?.id,startedAt:job?.startedAt,error:unsupported??(job?.state==='ready'&&!runtimeReady?'worker_unavailable':job?.error),runtime:this.options.runtime,runtimeReady,model,...(health.missingDependencies?{missingDependencies:health.missingDependencies}:{})};
  }
  async statuses(){return Object.fromEntries(await Promise.all(roles.map(async role=>[role,await this.status(role)])));}
  start(role:MediaRole,allowInstall=true){
    if(this.closing)throw new StoreError('Media preparation is closing',503);
    const unsupported=this.unsupported(role);if(unsupported)throw new StoreError(unsupported,409);
    const previous=this.jobs.get(role);if(previous&&active(previous.state))return this.status(role);
    const job:Job={id:randomUUID(),role,state:'queued',startedAt:new Date().toISOString(),controller:new AbortController(),done:Promise.resolve()};
    this.jobs.set(role,job);
    job.done=(this.stopping.get(role)??Promise.resolve()).then(()=>this.perform(job,allowInstall)).catch(error=>{
      const code=typeof error?.message==='string'&&/^media\.runtime\./.test(error.message)?error.message.replace('media.runtime.',''):error instanceof StoreError?'model_busy':'preparation_failed';
      job.state=job.controller.signal.aborted&&code!=='process_stop_failed'?'cancelled':'failed';job.error=job.state==='cancelled'?undefined:code;
    });
    return this.status(role);
  }
  async cancel(role:MediaRole){
    const job=this.jobs.get(role);if(job&&active(job.state)){job.controller.abort();await job.done;}
    return this.status(role);
  }
  /** Used by the local-image plugin: stop only this role, never shared ASR/OCR. */
  async stop(role:MediaRole){
    if(this.stopping.has(role)){await this.stopping.get(role);return this.status(role);}
    this.epochs.set(role,(this.epochs.get(role)??0)+1);
    const job=this.jobs.get(role);job?.controller.abort();
    const stopping=(async()=>{await job?.done;await this.stopWorker(role);if(job&&job===this.jobs.get(role)&&job.state!=='failed')job.state='idle';})();
    this.stopping.set(role,stopping);
    try{await stopping;}finally{if(this.stopping.get(role)===stopping)this.stopping.delete(role);}
    return this.status(role);
  }
  async restart(role:MediaRole,allowInstall=false){await this.stop(role);return this.start(role,allowInstall);}
  private check(job:Job){job.controller.signal.throwIfAborted();if(this.closing||this.changed||this.jobs.get(job.role)!==job)throw Error('media.runtime.configuration_changed');}
  private async perform(job:Job,allowInstall:boolean){
    this.check(job);const {assets,runtime,media}=this.options,role=job.role as NativeMediaRole;
    if(assets.ready(role)&&assets.status(role).state==='ready'&&(runtime==='docker'||this.owned(role))&&(await this.health(role,job.controller.signal)).ready){this.check(job);if(!assets.ready(role)||assets.status(role).state!=='ready')throw Error('media.runtime.model_install_failed');job.state='ready';return;}
    let prepared:Prepared|undefined;
    if(runtime==='native'){
      job.state='dependencies';
      prepared=await(this.options.prepare??prepareNativeMediaRuntime)({repository:this.repository,directory:this.directory,role,signal:job.controller.signal,allowInstall,onStage:stage=>{this.check(job);job.state=stage;}});
      this.check(job);
    }
    job.state='models';
    if(!allowInstall&&!assets.ready(role))throw Error('media.runtime.not_prepared');
    if(!assets.ready(role))await assets.installAsync(role,'auto',job.controller.signal);
    this.check(job);if(!assets.ready(role)||assets.status(role).state!=='ready')throw Error('media.runtime.model_install_failed');
    job.state='starting';let started:MediaProcess|undefined;
    try{
      if(runtime==='native'&&prepared){
        await this.stopWorker(role);this.check(job);
        const args=mediaWorkerLaunch(role,{repository:this.repository,...media,localImagePort:media.localImagePort??9011});
        if(await portOccupied(Number(args.at(-1))))throw Error('media.runtime.worker_port_in_use');
        this.check(job);const home=join(this.directory,role,'worker');await mkdir(home,{recursive:true,mode:0o700});this.check(job);
        started=spawnMediaProcess(prepared.python,args,{cwd:this.repository,env:mediaWorkerEnvironment(home,prepared.python,media.workerToken)});
        this.workers.set(role,started);const owned=started;
        void owned.done.then(()=>{if(this.workers.get(role)===owned)this.workers.delete(role);},()=>{});
      }
      const until=Date.now()+(this.options.startupTimeoutMs??120000);
      for(;;){
        this.check(job);
        const health=await this.health(role,job.controller.signal);this.check(job);
        if(started&&(started.error||started.child.exitCode!==null||started.child.signalCode!==null))throw Error('media.runtime.worker_start_failed');
        if(health.error)throw Error('media.runtime.'+health.error);
        if(health.ready){if(!assets.ready(role)||assets.status(role).state!=='ready')throw Error('media.runtime.model_install_failed');break;}
        if(Date.now()>=until)throw Error(runtime==='docker'?'media.runtime.sidecar_unavailable':'media.runtime.worker_start_failed');
        await delay(100,undefined,{signal:job.controller.signal});
      }
      this.check(job);job.state='ready';
    }catch(error){if(started){await started.close();if(this.workers.get(role)===started)this.workers.delete(role);}throw error;}
  }
  private async stopWorker(role:MediaRole){
    const worker=this.workers.get(role as NativeMediaRole);if(!worker)return;
    await worker.close();if(this.workers.get(role as NativeMediaRole)===worker)this.workers.delete(role as NativeMediaRole);
  }
  resume(){
    if(this.options.runtime!=='native')return;
    // VLM enablement belongs to IMG-02; merely restarting Central never enables it.
    for(const role of ['ocr','dialogue'] as const)if(!this.unsupported(role)&&existsSync(join(this.directory,role,'current.json'))&&this.options.assets.ready(role))void this.start(role,false);
  }
  invalidate(){this.changed=true;this.abort.abort();for(const job of this.jobs.values())job.controller.abort();for(const role of this.workers.keys())void this.stop(role).catch(()=>{});}
  async close(){
    this.closing=true;this.abort.abort();for(const job of this.jobs.values())job.controller.abort();
    await Promise.all([...this.jobs.values()].map(job=>job.done));await Promise.all([...this.stopping.values()]);
    const results=await Promise.allSettled([...this.workers.keys()].map(role=>this.stopWorker(role)));
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Media process cleanup failed');
  }
}
