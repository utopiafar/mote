import {fork,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import type {Config} from './config.js';

/** One deployable service, isolated CPU/disk maintenance with automatic recovery. */
export class MaintenanceWorker {
  private child?:ChildProcess;private timer?:ReturnType<typeof setTimeout>;private closed=false;
  private state={status:'starting',lastCompletedAt:null as string|null,durationMs:0,failures:0};
  constructor(private config:Config){this.start();}
  snapshot(){return {...this.state};}
  private start(){
    if(this.closed)return;
    const extension=import.meta.url.endsWith('.ts')?'ts':'js';
    // Inheriting -e/--eval re-executes the parent's bootstrap instead of this
    // worker (and can overwrite its PID lock). Only the source loader is needed.
    const execArgv=extension==='ts'?['--import',createRequire(import.meta.url).resolve('tsx')]:[];
    const child=this.child=fork(new URL(`./maintenance-worker.${extension}`,import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv});
    child.send({directory:this.config.dataDir,options:{maintenance:true,dataKey:this.config.dataKey,contentEncryptionEnabled:this.config.contentEncryptionEnabled,maxStorageBytes:this.config.maxStorageBytes,embeddingEnabled:Boolean(this.config.embeddingModel)}});
    child.on('message',(event:any)=>{if(event.type==='tick')this.state={...this.state,status:'ready',lastCompletedAt:new Date().toISOString(),durationMs:event.durationMs};else if(event.type==='error'){this.state.status='degraded';this.state.failures++;}});
    child.on('error',()=>{this.state.status='degraded';});
    child.once('exit',()=>{if(this.child===child)this.child=undefined;if(!this.closed){this.state.status='restarting';this.state.failures++;this.timer=setTimeout(()=>this.start(),5000);this.timer.unref();}});
  }
  async close(){this.closed=true;if(this.timer)clearTimeout(this.timer);const child=this.child;if(!child)return;await new Promise<void>(resolve=>{const force=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(force);resolve();});child.kill('SIGTERM');});}
}
