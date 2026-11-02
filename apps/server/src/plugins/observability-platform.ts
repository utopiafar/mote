import {monitorEventLoopDelay,type IntervalHistogram} from 'node:perf_hooks';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,PluginScope,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {TokenUsage,UsageAttribution,UsageReceipt} from '@mote/shared';
import type {Store} from '../store.js';
import {ServerDiagnostics,type ServerDiagnosticsOptions} from '../diagnostics.js';
import {ExecutionObservability,type ObservationClock} from '../execution-observability.js';
import {UsageLedger,type OperationUsage} from '../usage.js';
import {createUpdateService,type ReleaseCheck,type UpdateContext} from '../updates.js';
import {centralServices,type UsageRecording} from './central-contracts.js';

/** Private host configuration, never a Manifest configuration value or a wire DTO. */
export interface ObservabilityPlatformOptions {
  readonly logDirectory:string;
  readonly diagnostics?:Omit<ServerDiagnosticsOptions,'directory'>;
  /** Version/profile/runtime context for the existing read-only release service. */
  readonly update:UpdateContext;
  readonly eventLoopResolutionMs?:number;
  readonly updateDependencies?:{checkRelease?:ReleaseCheck;clock?:()=>number};
  readonly observerClock?:()=>ObservationClock|undefined;
}
export interface ObservabilityPlatformDependencies {
  /** C02-owned SQLite. The platform creates the ledger but never owns or closes the store. */
  readonly store:Store;
}

/** Value returned by a producer that has only been queued. Creating this handle
 * never writes a receipt: only an actual model start or token sample does. */
export interface AdmittedUsageMeter {
  /** Idempotent marker for a real model operation; queue admission alone is not usage. */
  modelStarted():void;
  update(tokens:TokenUsage):void;
  complete():UsageReceipt|undefined;
  fail():UsageReceipt|undefined;
}
export type AdmittedUsageFactory=(provider:string,model:string,operation:string,attribution?:UsageAttribution)=>AdmittedUsageMeter;

type FlatValue=string|number|boolean|null|undefined;
export interface DiagnosticReadEvent {readonly [field:string]:FlatValue}
export interface ObservabilityRead {
  /** Flat primitive counters; nested diagnostics limits/runtime are flattened. */
  snapshot():Readonly<Record<string,FlatValue>>;
  /** Bounded sanitized events. Detailed Agent trace payloads never leave here. */
  events(afterSeq?:number,limit?:number):Readonly<{items:readonly DiagnosticReadEvent[];nextSeq:number;oldestSeq:number|null}>;
}

/** Trusted H05/29 assembly only. Raw writer/handles never become an ordinary plugin port. */
export interface ObservabilityAssembly {
  readonly diagnostics:ServerDiagnostics;
  /** H05 binds value=>observer.lease(value), ()=>observer.enabled() on the real engine
   * and must call bindObserver(undefined) before execution/vault disposal. step.id and
   * claimed attempts are the diagnostic identity; the domain job id and the ledger's
   * receipt UUID remain independent namespaces. */
  readonly observer:ExecutionObservability;
  readonly usage:UsageLedger;
  readonly admittedUsage:AdmittedUsageFactory;
  readonly eventLoop:IntervalHistogram;
  readonly softwareUpdate:ReturnType<typeof createUpdateService>;
  read():ObservabilityRead;
  /** Invalidates this access only; it neither closes sibling accesses nor stops the platform. */
  release():void;
}

const unavailable=()=>Object.assign(new Error('Observability platform is unavailable'),{statusCode:503});
const flatSnapshot=(diagnostics:ServerDiagnostics):Readonly<Record<string,FlatValue>>=>{
  const value=diagnostics.snapshot();
  return Object.freeze({
    enabled:value.enabled,level:value.level,instanceId:value.instanceId,retainedEvents:value.retainedEvents,
    lastSeq:value.lastSeq,pendingWrites:value.pendingWrites,droppedEvents:value.droppedEvents,
    writeFailures:value.writeFailures,readFailures:value.readFailures,
    agentTraceEnabled:value.agentTrace.enabled,agentTraceRetainedEvents:value.agentTrace.retainedEvents,
    maxFileBytes:value.limits.maxFileBytes,maxFiles:value.limits.maxFiles,maxEvents:value.limits.maxEvents,
    uptimeMs:value.runtime.uptimeMs,rssBytes:value.runtime.rssBytes,
    cpuUserMicros:value.runtime.cpuUserMicros,cpuSystemMicros:value.runtime.cpuSystemMicros,
  });
};
const flatEvents=(diagnostics:ServerDiagnostics,afterSeq:number,limit:number)=>{
  const page=diagnostics.events(afterSeq,limit),items=page.items.map(event=>{
    const item:Record<string,FlatValue>={};
    for(const [key,value] of Object.entries(event)){
      if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')item[key]=value;
    }
    return Object.freeze(item);
  });
  return Object.freeze({items:Object.freeze(items),nextSeq:page.nextSeq,oldestSeq:page.oldestSeq});
};

/** H03 owns the package Manifest. This is the actual data-contribution fragment.
 * A restart platform owns the writer/ledger/observer/update objects; ordinary plugins
 * consume the frozen usage-recording port, never the diagnostics writer. */
export const observabilityPlatformContribution={
  id:'observability-platform',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[centralServices.usage].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const observabilityPlatformDeclaration={id:observabilityPlatformContribution.id,apiVersion:'1'} as const;
export const observabilityPlatformReplacement='restart' as const;

/** The existing admitted-usage semantics: a receipt exists only after a real
 * model start or sample, so queue/refusal/cancel-before-start leave no fake row. */
export function createAdmittedUsage(ledger:UsageLedger,available:()=>void=()=>{}):AdmittedUsageFactory {
  return (provider,model,operation,attribution)=>{
    let meter:ReturnType<UsageLedger['start']>|undefined;
    const start=()=>{available();return meter??=ledger.start(provider,model,operation,attribution);};
    return Object.freeze({
      modelStarted:start,
      update:(tokens:TokenUsage)=>{available();start().update(tokens);},
      complete:()=>{available();return meter?.finish('completed');},
      fail:()=>{available();return meter?.finish('failed');},
    });
  };
}

export interface ObservabilityPlatform extends PluginLifecycle {
  /** Trusted assembly wiring only. Caller-supplied scopes are not a public capability. */
  forAssembly(scope:PluginScope):ObservabilityAssembly;
  /** Public sanitized read view for host/UI contributions; no writer, trace or raw file. */
  read(scope:PluginScope):ObservabilityRead;
  /** Frozen ordinary-consumer port; it exposes no ledger summary, price or writer. */
  usagePort():UsageRecording;
  close():Promise<void>;
}

export function createObservabilityPlatform(options:ObservabilityPlatformOptions,dependencies:ObservabilityPlatformDependencies):ObservabilityPlatform {
  const config={...options};
  if(!config.logDirectory)throw unavailable();
  if(!Number.isSafeInteger(config.eventLoopResolutionMs??20)||(config.eventLoopResolutionMs??20)<1)throw unavailable();
  let diagnostics:ServerDiagnostics|undefined,observer:ExecutionObservability|undefined;
  let ledger:UsageLedger|undefined,admitted:AdmittedUsageFactory|undefined;
  let eventLoop:IntervalHistogram|undefined,softwareUpdate:ReturnType<typeof createUpdateService>|undefined;
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopping'|'stopped'|'disposed'='created';
  let closing:Promise<void>|undefined;
  const current=()=>{if(phase!=='active'&&phase!=='quiescing')throw unavailable();};
  /** The host guards a service call, not methods on the object it returns. A
   * retained meter must therefore recheck this platform on every write: accepted
   * work may drain while quiescing, but a stopped/disposed platform rejects. */
  const guardedMeter=(meter:ReturnType<UsageLedger['start']>)=>Object.freeze({
    update:(tokens:TokenUsage)=>{current();meter.update(tokens);},
    finish:(status:'completed'|'failed')=>{current();return meter.finish(status);},
  });
  const usagePort:UsageRecording=Object.freeze({
    start:(...args)=>{current();if(!ledger)throw unavailable();return guardedMeter(ledger.start(...args));},
    operation:(operationId:string,createdAt?:string,finishedAt?:string):OperationUsage=>{current();if(!ledger)throw unavailable();return ledger.operation(operationId,createdAt,finishedAt);},
  });
  const view=(check:()=>void):ObservabilityRead=>Object.freeze({
    snapshot:()=>{check();return flatSnapshot(diagnostics!);},
    events:(afterSeq=0,limit=500)=>{check();return flatEvents(diagnostics!,afterSeq,limit);},
  });
  const read=(scope:PluginScope):ObservabilityRead=>{
    current();scope.assertCurrent();scope.signal.throwIfAborted();
    let released=false;
    const check=()=>{if(released)throw unavailable();current();scope.assertCurrent();scope.signal.throwIfAborted();};
    scope.defer(()=>{released=true;});
    return view(check);
  };
  function acquire(scope:PluginScope):ObservabilityAssembly {
    current();scope.assertCurrent();scope.signal.throwIfAborted();
    let released=false;
    const check=()=>{if(released)throw unavailable();current();scope.assertCurrent();scope.signal.throwIfAborted();};
    const release=()=>{released=true;};
    scope.defer(release);
    return Object.freeze({
      get diagnostics(){check();return diagnostics!;},
      get observer(){check();return observer!;},
      get usage(){check();return ledger!;},
      get admittedUsage(){check();return admitted!;},
      get eventLoop(){check();return eventLoop!;},
      get softwareUpdate(){check();return softwareUpdate!;},
      read:()=>{check();return view(check);},
      release,
    });
  }
  async function dispose(reason:StopReason='shutdown'){
    if(closing)return closing;
    phase='stopping';
    closing=(async()=>{
      const errors:unknown[]=[];
      const clean=async(work:()=>unknown|Promise<unknown>)=>{try{await work();}catch(error){errors.push(error);}};
      // Timers and the updater stop first; accepted diagnostics writes then drain.
      await clean(()=>{eventLoop?.disable();});
      await clean(()=>softwareUpdate?.close());
      await clean(()=>{observer?.close();});
      await clean(()=>{if(diagnostics){diagnostics.record('server.stopping');return diagnostics.close();}});
      phase='disposed';
      if(errors.length)throw new AggregateError(errors,'Observability platform disposal failed');
    })();
    return closing;
  }
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{
        diagnostics=new ServerDiagnostics({...config.diagnostics,directory:config.logDirectory});
        await diagnostics.init();
        if(phase!=='created'){await diagnostics.close();throw unavailable();}
        observer=new ExecutionObservability(diagnostics,config.observerClock);
        ledger=new UsageLedger(dependencies.store);
        admitted=createAdmittedUsage(ledger,current);
        eventLoop=monitorEventLoopDelay({resolution:config.eventLoopResolutionMs??20});
        softwareUpdate=createUpdateService(config.update,config.updateDependencies);
        phase='prepared';
      }catch(error){
        try{await dispose('startup_failed');}catch(cleanup){throw new AggregateError([error,cleanup],'Observability preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){
      if(phase!=='prepared')throw unavailable();
      eventLoop!.enable();
      phase='active';
    },
    quiesce(_reason?:StopReason){if(phase==='active'){phase='quiescing';eventLoop?.disable();}},
    stop:async(reason:StopReason)=>{await dispose(reason);},
    dispose:()=>dispose('shutdown'),
    close:()=>dispose('shutdown'),
    forAssembly:acquire,
    read,
    usagePort:()=>usagePort,
  });
}

/** Compiled trusted H04 owner. The published contribution is only the frozen
 * usage-recording port; writer, event loop, update service and raw reads stay
 * behind the trusted assembly. */
export function createObservabilityPlatformFactory(options:ObservabilityPlatformOptions,dependencies:ObservabilityPlatformDependencies){
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createObservabilityPlatform(options,dependencies);
    context.scope.defer(()=>platform.close());
    return {...platform,start:async()=>{
      platform.start();
      context.provide(observabilityPlatformContribution.id,centralServices.usage,platform.usagePort());
    }};
  };
}
