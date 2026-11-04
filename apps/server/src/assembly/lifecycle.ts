import type {IntervalHistogram} from 'node:perf_hooks';
import type {FastifyInstance} from 'fastify';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {ConfigurationPlatform} from '../plugins/configuration-platform.js';
import type {ExecutionPlatform} from '../plugins/execution-platform.js';
import type {ServerFeatureHost} from '../feature-host.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {DelegatedQueryRuns} from '../delegated-query-runs.js';
import type {ActivityServices} from '../plugins/activity-services.js';
import type {MemoryPublication} from '../memory-publication.js';
import type {FeatureServices} from '../feature-services.js';

/** Shared shutdown latch. Admission paths poll it while handlers still run;
 * the close-order hooks set it before interrupting transports. */
export interface ServerLifecycle {
  readonly isClosing:()=>boolean;
  readonly markClosing:()=>void;
  readonly featureServices:Pick<FeatureServices,'isClosing'>;
}

export function createServerLifecycle():ServerLifecycle{
  let closing=false;
  const isClosing=()=>closing;
  return Object.freeze({isClosing,markClosing:()=>{closing=true;},featureServices:Object.freeze({isClosing})});
}

export interface ServerLifecycleHookDependencies {
  readonly lifecycle:ServerLifecycle;
  readonly configurationPlatform:ConfigurationPlatform;
  readonly featureHost:ServerFeatureHost;
  readonly sourcePipelines:SourcePipelineRuntime;
  readonly executionPlatform:ExecutionPlatform;
  readonly executor:ExecutionEngine;
  readonly eventLoop:IntervalHistogram;
  readonly queryRuns:DelegatedQueryRuns;
  readonly activityServices:ActivityServices;
  readonly memoryPublication:MemoryPublication;
  readonly resources:ServerResources;
  readonly diagnostics:ServerDiagnostics;
}

/** The preClose/onClose order app.ts previously held inline: stop admission,
 * quiesce platforms, interrupt polling and transports while handlers and
 * stores are still live, then release every registered resource. */
export function installServerLifecycleHooks(app:FastifyInstance,dependencies:ServerLifecycleHookDependencies){
  const {lifecycle,configurationPlatform,featureHost,sourcePipelines,executionPlatform,executor,eventLoop,queryRuns,activityServices,memoryPublication,resources,diagnostics}=dependencies;
  app.addHook('preClose',async()=>{
    lifecycle.markClosing();
    // Stop watcher/subscriptions and join accepted configuration transactions
    // while execution/model consumers are still alive; a config-service failure
    // must not abort the remaining cleanup. Bootstrap retains final close.
    let configDrainFailure:unknown;
    try{await configurationPlatform.quiesce('shutdown');}catch(error){configDrainFailure=error;}
    try{featureHost.stop();
    // Polling/admission stops without retiring the runtime's Memory authority;
    // the runtime closes only after accepted engine work is interrupted/drained.
    sourcePipelines.quiesce();
    executionPlatform.quiesce('shutdown');
    executor.bindObserver(undefined);eventLoop.disable();queryRuns.interrupt();
    activityServices.quiesce('shutdown');memoryPublication.stop();
    // Interrupt transports while handlers, checkpoints and storage remain live.
    await resources.stop();
    }finally{if(configDrainFailure)try{diagnostics.record('config.shutdown_drain_failed',{category:'internal'},'error');}catch{/* cleanup continues */}}
  });
  app.addHook('onClose',async()=>resources.close());
}
