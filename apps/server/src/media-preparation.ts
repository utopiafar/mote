import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareNativeMediaRuntime} from './media-native-runtime.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {MediaAssets,type MediaRole} from './media-assets.js';
import type {MediaConfiguration} from './media-configuration.js';
import {StoreError} from './store.js';

type State='idle'|'queued'|'dependencies'|'verifying_dependencies'|'models'|'starting'|'ready'|'failed'|'cancelled'|'unsupported';
type Job={id:string;role:MediaRole;state:State;error?:string;startedAt:string;controller:AbortController;done:Promise<void>};
type Prepared={python:string};
type RuntimeModule={prepareNativeMediaRuntime(options:{repository:string;directory:string;signal:AbortSignal;allowInstall:boolean;onStage:(stage:'dependencies'|'verifying_dependencies')=>void}):Promise<Prepared>};
type Worker={child:ChildProcess;done:Promise<void>;close:()=>Promise<void>};
type Options={runtime:'native'|'docker'|'unknown';media:MediaConfiguration;assets:MediaAssets;repository?:string;prepare?:(options:Parameters<RuntimeModule['prepareNativeMediaRuntime']>[0])=>Promise<Prepared>;fetch?:typeof fetch;startupTimeoutMs?:number};
const active=(state:State)=>['queued','dependencies','verifying_dependencies','models','starting'].includes(state);
/** One Central lifecycle owns native workers. Docker sidecars remain deployment-owned. */
export class MediaPreparation {
  private jobs=new Map<MediaRole,Job>();
  private workers=new Map<'ocr'|'dialogue',Worker>();
  private workersStopping?:Promise<void>;
  private tail=Promise.resolve();
  private closing=false;
  private changed=false;
  private abort=new AbortController();
  private repository:string;
  readonly directory:string;
  constructor(private options:Options){
    this.repository=options.repository??resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
    this.directory=join(options.assets.root,'runtime');
  }
  private unsupported(){
    const {runtime,media}=this.options;
    if(this.changed)return 'configuration_changed';
    if(runtime==='unknown')return 'runtime_unknown';
    if(!media.workerToken)return 'worker_auth_missing';
    if(runtime==='native'){
      if(!['darwin','linux'].includes(process.platform)||!['arm64','x64'].includes(process.arch)||process.platform==='linux'&&!(process.report?.getReport() as {header?:{glibcVersionRuntime?:string}}).header?.glibcVersionRuntime)return 'platform_unsupported';
      if(media.ocrEndpoint!==`http://127.0.0.1:${media.ocrPort}/ocr`||media.asrEndpoint!==`http://127.0.0.1:${media.asrPort}/transcribe`)return 'external_worker';
    }
    return undefined;
  }
  private async health(role:MediaRole){
    const {media}=this.options;if(!media.workerToken)return false;
    const url=new URL(role==='ocr'?media.ocrEndpoint:media.asrEndpoint);url.pathname='/health';url.search='';url.hash='';
    try{
      const response=await(this.options.fetch??fetch)(url,{headers:{Authorization:`Bearer ${media.workerToken}`},redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(2500)])});
      if(!response.ok)return false;
      const result=await response.json() as {ocr?:boolean;asr?:boolean;diarization?:boolean;wespeaker?:boolean};
      return role==='ocr'?result.ocr===true:role==='speaker-wespeaker'?result.asr===true&&result.diarization===true&&result.wespeaker===true:result.asr===true&&result.diarization===true;
    }catch{return false;}
  }
  async status(role:MediaRole){
    const job=this.jobs.get(role),unsupported=this.unsupported(),model=this.options.assets.status(role);
    const runtimeReady=!this.closing&&!this.changed&&model.state==='ready'&&await this.health(role);
    return {role,state:unsupported?'unsupported':job?.state==='ready'&&!runtimeReady?'failed':job?.state??(runtimeReady?'ready':'idle'),id:job?.id,startedAt:job?.startedAt,error:unsupported??(job?.state==='ready'&&!runtimeReady?'worker_unavailable':job?.error),runtime:this.options.runtime,runtimeReady,model};
  }
  async statuses(){return Object.fromEntries(await Promise.all((['ocr','dialogue','speaker-wespeaker'] as const).map(async role=>[role,await this.status(role)])));}
  start(role:MediaRole,allowInstall=true){
    if(this.closing)throw new StoreError('Media preparation is closing',503);
    const unsupported=this.unsupported();if(unsupported)throw new StoreError(unsupported,409);
    const previous=this.jobs.get(role);if(previous&&active(previous.state))return this.status(role);
    const job:Job={id:randomUUID(),role,state:'queued',startedAt:new Date().toISOString(),controller:new AbortController(),done:Promise.resolve()};
    this.jobs.set(role,job);
    // Dependencies are shared by a profile. Serial preparation prevents competing
    // environment publications; independently running workers are left intact.
    job.done=this.tail.then(()=>this.perform(job,allowInstall)).catch(error=>{job.state=job.controller.signal.aborted?'cancelled':'failed';job.error=job.controller.signal.aborted?undefined:typeof error?.message==='string'&&/^media\.runtime\./.test(error.message)?error.message.replace('media.runtime.',''):error instanceof StoreError?'model_busy':'preparation_failed';});
    this.tail=job.done;return this.status(role);
  }
  async cancel(role:MediaRole){const job=this.jobs.get(role);if(job&&active(job.state)){const queued=job.state==='queued';job.controller.abort();if(queued)job.state='cancelled';else await job.done;}return this.status(role);}
  private check(job:Job){job.controller.signal.throwIfAborted();if(this.closing||this.changed||this.jobs.get(job.role)!==job)throw Error('media.runtime.configuration_changed');}
  private async perform(job:Job,allowInstall:boolean){
    this.check(job);const {assets,runtime,media}=this.options;
    if(assets.ready(job.role)&&await this.health(job.role)){this.check(job);job.state='ready';return;}
    let prepared:Prepared|undefined;
    if(runtime==='native'){
      job.state='dependencies';
      const prepare=this.options.prepare??prepareNativeMediaRuntime;
      prepared=await prepare({repository:this.repository,directory:this.directory,signal:job.controller.signal,allowInstall,onStage:stage=>{this.check(job);job.state=stage;}});
      this.check(job);
    }
    job.state='models';
    const roles:MediaRole[]=job.role==='speaker-wespeaker'?['dialogue','speaker-wespeaker']:[job.role];
    for(const role of roles){this.check(job);if(!allowInstall&&!assets.ready(role))throw Error('media.runtime.not_prepared');await assets.installAsync(role,'official',job.controller.signal);}
    this.check(job);job.state='starting';
    const workerRole=job.role==='ocr'?'ocr':'dialogue';let started:Worker|undefined;
    try{
      if(runtime==='native'&&prepared&&!await this.health(job.role)){
        this.check(job);
        // An existing worker may reload an optional model. Never kill an external
        // endpoint, nor a healthy owned worker used by another processing job.
        if(!this.workers.has(workerRole)){
          started=this.launch(workerRole,prepared.python);this.workers.set(workerRole,started);
        }
      }
      const until=Date.now()+(this.options.startupTimeoutMs??120000);
      while(!await this.health(job.role)){
        this.check(job);
        if(Date.now()>=until)throw Error(runtime==='docker'?'media.runtime.sidecar_unavailable':'media.runtime.worker_start_failed');
        if(started&&(started.child.exitCode!==null||started.child.signalCode!==null))throw Error('media.runtime.worker_start_failed');
        await delay(400,undefined,{signal:job.controller.signal});
      }
      this.check(job);job.state='ready';
    }catch(error){if(started){await started.close();if(this.workers.get(workerRole)===started)this.workers.delete(workerRole);}throw error;}
  }
  private launch(role:'ocr'|'dialogue',python:string):Worker{
    const {media}=this.options;
    const args=role==='ocr'?['ocr-server.py','--model-root',join(media.modelDirectory,'ocr'),'--port',String(media.ocrPort)]:['transcription-server.py','--model',join(media.modelDirectory,'dialogue'),'--segmentation-model',join(media.modelDirectory,'dialogue/segmentation.onnx'),'--speaker-model',join(media.modelDirectory,'dialogue/speaker.onnx'),'--wespeaker-model',join(media.modelDirectory,'speaker-wespeaker/speaker.onnx'),'--timeout','3600','--port',String(media.asrPort)];
    args[0]=join(this.repository,'scripts',args[0]);
    const clean=Object.fromEntries(['LANG','TMPDIR','TMP','TEMP'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
    const child=spawn(python,args,{cwd:this.repository,env:{...clean,PATH:`${dirname(python)}:${process.env.PATH??'/usr/bin:/bin'}`,PYTHONUNBUFFERED:'1',PYTHONNOUSERSITE:'1',PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:'True',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',MOTE_MEDIA_WORKER_TOKEN:media.workerToken},stdio:'ignore'});
    let exited=false;
    const done=new Promise<void>(resolve=>{child.once('error',()=>{});child.once('close',()=>{exited=true;resolve();});});
    const worker:Worker={child,done,close:async()=>{if(exited)return;child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done;}finally{clearTimeout(force);}}};
    void done.then(()=>{if(this.workers.get(role)===worker)this.workers.delete(role);});return worker;
  }
  resume(){
    if(this.options.runtime!=='native'||this.unsupported()||!existsSync(join(this.directory,'current.json')))return;
    for(const role of ['ocr','dialogue'] as const)if(this.options.assets.ready(role))void this.start(role,false);
  }
  invalidate(){this.changed=true;this.abort.abort();for(const job of this.jobs.values())if(active(job.state))job.controller.abort();void this.stopWorkers();}
  private stopWorkers(){
    if(this.workersStopping)return this.workersStopping;
    const owned=[...this.workers.values()];this.workers.clear();
    const stopping=Promise.all(owned.map(worker=>worker.close())).then(()=>{});this.workersStopping=stopping;
    void stopping.finally(()=>{if(this.workersStopping===stopping)this.workersStopping=undefined;});return stopping;
  }
  async close(){this.closing=true;this.abort.abort();for(const job of this.jobs.values())job.controller.abort();await this.tail;await this.stopWorkers();}
}
