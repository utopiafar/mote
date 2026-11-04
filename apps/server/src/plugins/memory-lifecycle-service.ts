import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {ConfigService} from '../config-service.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {FileStore} from '../files.js';
import type {InsightRuns} from '../insight-runs.js';
import type {MemoryIntegrationSettings} from '../memory-integration-settings.js';
import type {MemoryPipeline} from '../memory-pipeline.js';
import type {MemoryStore} from '../memory.js';
import {StoreError} from '../store.js';
import {recoverableMemoryJobs,registerMemoryExtensions} from '../lifecycle-extensions.js';
import {MemoryLifecycle,type LifecycleExtension} from '../memory-lifecycle.js';
import {WorkingMemory} from '../working-memory.js';
import {centralServices} from './central-contracts.js';

type Store=ConstructorParameters<typeof MemoryLifecycle>[0];

/** C22B owns the durable Memory lifecycle, its default extension registrations
 * and the working-memory compactor. The idle poll and explicit job recovery
 * belong to the same activation so disabling Memory stops them together. */
export const memoryLifecycleServiceContribution={
  id:'memory-lifecycle-service',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.memoryPhase.id,version:'1.0.0'},
    {kind:'service',id:centralServices.memoryRecords.id,version:'1.0.0'},
  ],
  provides:[{kind:'service',id:centralServices.memoryLifecycle.id,apiVersion:centralServices.memoryLifecycle.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const memoryLifecycleServiceDeclaration={id:memoryLifecycleServiceContribution.id,apiVersion:'1'} as const;
/** Windows, cursors, extension receipts and working summaries are durable in
 * the vault; a fresh activation resumes them without a process restart. */
export const memoryLifecycleServiceReplacement='hot' as const;

export interface MemoryLifecycleServiceDependencies {
  readonly store:Store;
  readonly configService?:ConfigService;
  readonly executor?:ExecutionEngine;
  readonly semanticContextTime?:()=>string;
  readonly configured:()=>boolean;
  readonly conversations:ConstructorParameters<typeof WorkingMemory>[1];
  readonly files:FileStore;
  readonly memories:MemoryStore;
  readonly pipeline:MemoryPipeline;
  readonly integrationSettings:MemoryIntegrationSettings;
  readonly semanticArtifacts?:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  readonly providerCooldownCheck?:()=>void;
  readonly insights?:InsightRuns;
  readonly insightTimeout?:()=>number|null;
  readonly query:(input:QueryInput,module:'memories'|'insights'|'conversations')=>Promise<QueryResult>;
  readonly model:()=>string;
  /** Background polling and periodic recovery; startup recovery always runs. */
  readonly automatic?:boolean;
  /** Defer startup recovery until the HTTP feature host is ready; periodic
   * recovery still belongs to this activation. */
  readonly whenReady?:(task:()=>void)=>void;
  /** Test/assembly extensions replace their built-in definitions after the
   * default registrations; a second copy is never installed. */
  readonly extensions?:readonly LifecycleExtension[];
  readonly pollIntervalMs?:number;
  readonly recoveryIntervalMs?:number;
}

export interface MemoryLifecycleServicePort {
  readonly lifecycle:MemoryLifecycle;
  readonly working:WorkingMemory;
}

export interface MemoryLifecycleServiceBindings {
  readonly memoryLifecycle:ServiceBinding;
}

export interface MemoryLifecycleServicePlatform extends PluginLifecycle {
  readonly port:MemoryLifecycleServicePort;
  readonly lifecycle:MemoryLifecycle;
  readonly working:WorkingMemory;
  prepare():void;
  start():void;
  quiesce(reason?:StopReason):void;
  stop(reason?:StopReason):Promise<void>;
  dispose():Promise<void>;
  close():Promise<void>;
  /** One owned poll: lifecycle windows plus explicit durable-job recovery. */
  tick():Promise<void>;
}

const unavailable=()=>new StoreError('Memory lifecycle is unavailable',503);

/** Prepare constructs the lifecycle/working objects and registers each default
 * extension once. Start installs the activation's single poll and recovers
 * explicitly activated jobs. Quiesce fences new windows and stops the poll;
 * stop waits for interrupted invocations to settle while keeping their durable
 * checkpoints; close releases the lifecycle for the final shutdown. */
export function createMemoryLifecycleService(dependencies:MemoryLifecycleServiceDependencies):MemoryLifecycleServicePlatform {
  const pollIntervalMs=dependencies.pollIntervalMs??60000;
  const recoveryIntervalMs=dependencies.recoveryIntervalMs??5000;
  if(!Number.isFinite(pollIntervalMs)||pollIntervalMs<=0)throw new RangeError('Invalid Memory lifecycle poll interval');
  if(!Number.isFinite(recoveryIntervalMs)||recoveryIntervalMs<=0)throw new RangeError('Invalid Memory recovery poll interval');
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let lifecycle:MemoryLifecycle|undefined,working:WorkingMemory|undefined;
  let poll:ReturnType<typeof setInterval>|undefined,recovery:ReturnType<typeof setInterval>|undefined;
  let inflight:Promise<void>|undefined,closing:Promise<void>|undefined;
  let ready=!dependencies.whenReady,readyRequested=false;
  const recovering=new Set<string>();
  const readable=()=>{
    if(!lifecycle||!working||phase==='created'||phase==='disposed')throw unavailable();
    return {lifecycle,working};
  };
  const clearTimers=()=>{if(poll)clearInterval(poll);poll=undefined;if(recovery)clearInterval(recovery);recovery=undefined;};
  const recover=()=>{
    if(!ready||phase!=='active')return;
    const current=readable().lifecycle;
    for(const id of recoverableMemoryJobs(dependencies.store,current)){
      if(recovering.has(id))continue;
      recovering.add(id);
      void dependencies.pipeline.run(id).catch(()=>{}).finally(()=>{recovering.delete(id);});
    }
  };
  const requestReady=()=>{
    if(ready)return recover();
    if(readyRequested||!dependencies.whenReady)return;
    readyRequested=true;
    dependencies.whenReady(()=>{ready=true;recover();});
  };
  const tick=()=>{
    if(phase!=='active'||inflight)return inflight??Promise.resolve();
    const task=(async()=>{await readable().lifecycle.tick();recover();})();
    inflight=task;
    void task.catch(()=>{}).finally(()=>{if(inflight===task)inflight=undefined;});
    return task;
  };
  const close=()=>closing??=(async()=>{
    phase='disposed';clearTimers();
    const errors:unknown[]=[];
    const owned=lifecycle;lifecycle=undefined;working=undefined;
    try{await owned?.close();}catch(error){errors.push(error);}
    try{await inflight;}catch{/* accepted window failures stay in their durable receipt */}
    if(errors.length)throw new AggregateError(errors,'Memory lifecycle disposal failed');
  })();
  const port:MemoryLifecycleServicePort=Object.freeze({
    get lifecycle(){return readable().lifecycle;},
    get working(){return readable().working;},
  });
  return Object.freeze({
    port,
    get lifecycle(){return readable().lifecycle;},
    get working(){return readable().working;},
    prepare(){
      if(phase!=='created')throw unavailable();
      let ownedLifecycle:MemoryLifecycle|undefined,ownedWorking:WorkingMemory|undefined;
      try{
        ownedWorking=new WorkingMemory(dependencies.store,dependencies.conversations);
        ownedLifecycle=new MemoryLifecycle(dependencies.store,dependencies.configured,Date.now,dependencies.executor,dependencies.semanticContextTime,dependencies.configService);
        registerMemoryExtensions({
          integrationSettings:dependencies.integrationSettings,lifecycle:ownedLifecycle,store:dependencies.store,files:dependencies.files,
          memories:dependencies.memories,pipeline:dependencies.pipeline,working:ownedWorking,query:dependencies.query,model:dependencies.model,
          semanticArtifacts:dependencies.semanticArtifacts,providerCooldownCheck:dependencies.providerCooldownCheck,insights:dependencies.insights,
          insightTimeout:dependencies.insightTimeout,
        });
        for(const extension of dependencies.extensions??[])ownedLifecycle.replace(extension);
        lifecycle=ownedLifecycle;working=ownedWorking;phase='prepared';
      }catch(error){
        // A mid-prepare failure must not leave a closed-over abort controller or
        // partially installed configuration handler behind.
        void ownedLifecycle?.close().catch(()=>{});
        throw error;
      }
    },
    start(){
      if(phase==='active')return;
      if(phase!=='prepared'&&phase!=='stopped')throw unavailable();
      const current=readable().lifecycle;
      current.start();
      phase='active';
      if(dependencies.automatic!==false){
        poll=setInterval(()=>{void tick().catch(()=>{});},pollIntervalMs);
        poll.unref?.();
        recovery=setInterval(recover,recoveryIntervalMs);
        recovery.unref?.();
      }
      requestReady();
    },
    quiesce(_reason?:StopReason){
      if(phase!=='active')return;
      phase='quiescing';clearTimers();
      void readable().lifecycle.quiesce().catch(()=>{});
    },
    async stop(_reason?:StopReason){
      if(phase==='stopped'||phase==='disposed')return;
      if(phase==='created'){phase='stopped';return;}
      phase='quiescing';clearTimers();
      await readable().lifecycle.quiesce();
      await inflight?.catch(()=>{});
      phase='stopped';
    },
    dispose:close,
    close,
    tick,
  });
}
export type MemoryLifecycleService=ReturnType<typeof createMemoryLifecycleService>;

export function createMemoryLifecycleServiceFactory(platform:MemoryLifecycleServicePlatform,onStarted?:(bindings:MemoryLifecycleServiceBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const bindings=context.provide(memoryLifecycleServiceContribution.id,centralServices.memoryLifecycle,platform.port);
        onStarted?.({memoryLifecycle:bindings});
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
