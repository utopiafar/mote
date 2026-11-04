import type {Context} from '@deepseek-ai/cordis';
import type {FastifyInstance} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,PluginScope,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {ModelSettings} from '@mote/shared/models';
import type {ConfigService} from '../config-service.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {MaterialStore} from '../materials.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {ModelAgentIdentity} from '../model-agent.js';
import type {MediaAssets} from '../media-assets.js';
import type {MediaRuntimeSettings} from '../media-configuration.js';
import type {ModelProcessingAuthority} from '../model-processing-authority.js';
import {ProcessingRuntime} from '../processing-runtime.js';
import {FileProcessing,type FileAnalysis,type TranscriptionProvider} from '../file-processing.js';
import type {FileProcessorContribution} from '../file-processors.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';
import {contributeDomainRoutes} from './domain-routes.js';
import {registerProcessingJobRoutes} from '../features/processing/processing-services.js';

/** C17's durable ProcessingRuntime, its job storage/poll and FileProcessing.
 * Materials source a product consumer from the same activation. */
export const processingServicesContribution={
  id:'processing-services',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'host',id:'mote.owner-authorization',version:'1.0.0'},
    {kind:'service',id:centralServices.execution.id,version:'1.0.0'},
  ],
  provides:[{kind:'service',id:centralServices.processing.id,apiVersion:centralServices.processing.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const processingServicesDeclaration={id:processingServicesContribution.id,apiVersion:'1'} as const;
/** Durable processing jobs and file work survive a stopped activation. */
export const processingServicesReplacement='hot' as const;

export type ProcessingJobPort=Pick<ProcessingRuntime,'enqueue'|'view'|'retry'|'cancel'|'save'>;
export type ProcessingServicesPhase='created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed';
export type ProcessingServicesPort=ProcessingJobPort&{readonly phase:ProcessingServicesPhase};

export interface ProcessingServicesDependencies {
  readonly store:ConstructorParameters<typeof ProcessingRuntime>[0];
  readonly files:ConstructorParameters<typeof FileProcessing>[0];
  readonly configService:ConfigService;
  readonly diagnostics:ServerDiagnostics;
  readonly executor:ExecutionEngine;
  readonly backendContext:Context;
  readonly materials:MaterialStore;
  readonly sourcePipelines:SourcePipelineRuntime;
  readonly mediaAssets:MediaAssets;
  readonly transcriptionProvider?:TranscriptionProvider;
  readonly modules:readonly string[];
  readonly media?:Partial<MediaRuntimeSettings>;
  readonly modelAuthority:ModelProcessingAuthority;
  readonly analyze:FileAnalysis;
  readonly analysisSnapshot:(settings:Parameters<FileAnalysis>[2])=>{settings:ModelSettings;identity:ModelAgentIdentity};
  readonly analysisRevision:()=>number;
  readonly semanticFingerprint:()=>string;
  /** Additional activation-owned processor contributions; built-ins remain the default. */
  readonly contributions?:readonly FileProcessorContribution[];
  /** Defaults to the previous file-work poll interval. */
  readonly pollIntervalMs?:number;
}

export interface ProcessingServices {
  readonly port:ProcessingServicesPort;
  readonly workflows:ProcessingRuntime;
  readonly processing:FileProcessing;
  prepare(scope?:Pick<PluginScope,'defer'>):Promise<void>;
  start():void;
  quiesce(reason?:StopReason):void;
  stop(reason?:StopReason):Promise<void>;
  dispose():Promise<void>;
  close():Promise<void>;
  /** One poll-owned pass: intake discovery plus the shared execution drain. */
  tick():Promise<void>;
  /** Contribute the domain route table from this activation. */
  contributeRoutes():void;
  /** Mounted once before listen; handlers resolve the current activation. */
  routes(app:FastifyInstance):void;
}

export interface ProcessingServicesStarted {readonly workflows:ProcessingRuntime;readonly processing:FileProcessing}

const unavailable=()=>new StoreError('Processing services are unavailable',503);

/** Owns the durable job runtime and file processing objects. Stopping fences
 * new submissions and drains the accepted poll without disposing handlers, so
 * re-enabling keeps exactly one registration and poll over the same profile. */
export function createProcessingServices(dependencies:ProcessingServicesDependencies):ProcessingServices {
  const pollIntervalMs=dependencies.pollIntervalMs??5000;
  if(!Number.isFinite(pollIntervalMs)||pollIntervalMs<=0)throw new RangeError('Invalid processing poll interval');
  let phase:ProcessingServicesPhase='created',workflows:ProcessingRuntime|undefined,processing:FileProcessing|undefined;
  let poll:ReturnType<typeof setInterval>|undefined,inflight:Promise<void>|undefined,closing:Promise<void>|undefined;
  let previousSourceContextChanged:MaterialStore['onSourceContextChanged'];
  let contributionsInstalled=false,routesContributed=false;
  const mounted=new WeakSet<FastifyInstance>();
  const readable=()=>phase==='prepared'||phase==='active'||phase==='quiescing';
  const writable=()=>{
    if(phase!=='active'||!workflows)throw unavailable();
    return workflows;
  };
  const read=()=>{
    if(!readable()||!workflows)throw unavailable();
    return workflows;
  };
  const stopPoll=()=>{if(poll)clearInterval(poll);poll=undefined;};
  const runPoll=()=>{
    if(phase!=='active'||inflight)return inflight??Promise.resolve();
    const task=(async()=>{processing!.prepare();await dependencies.executor.tick();})();
    inflight=task;
    void task.finally(()=>{if(inflight===task)inflight=undefined;}).catch(()=>{});
    return task;
  };
  const startPoll=()=>{
    if(poll)return;
    poll=setInterval(()=>{void runPoll().catch(()=>{});},pollIntervalMs);
    poll.unref?.();
  };
  const relay=(sourceId:string)=>{
    previousSourceContextChanged?.(sourceId);
    processing?.invalidateSourceContext(sourceId);
  };
  const restoreSourceContext=()=>{
    if(dependencies.materials.onSourceContextChanged!==relay)return;
    dependencies.materials.onSourceContextChanged=previousSourceContextChanged;
  };
  const installContributions=()=>{
    if(contributionsInstalled)return;
    processing!.installContributions(dependencies.contributions,{imageRecipes:false});
    contributionsInstalled=true;
  };
  const removeContributions=()=>{
    if(!contributionsInstalled)return;
    contributionsInstalled=false;
    processing?.uninstallContributions();
  };
  const routes=(app:FastifyInstance)=>{
    if(mounted.has(app))throw new StoreError('Processing routes are already installed',409);
    if(phase==='created'||phase==='disposed')throw unavailable();
    mounted.add(app);
    app.register(async child=>{
      child.addHook('onRequest',async(request,reply)=>{
        const write=['POST','PUT','PATCH','DELETE'].includes(request.method);
        if(write?phase!=='active':!readable())return reply.code(503).send({error:'feature_unavailable'});
      });
      registerProcessingJobRoutes(child,{store:dependencies.store,processing:()=>port,semanticFingerprint:dependencies.semanticFingerprint});
    });
  };
  const contributeRoutes=()=>{
    if(routesContributed||!dependencies.backendContext)return;
    contributeDomainRoutes(dependencies.backendContext,{'mote.processing':Object.freeze({mount:routes})});
    routesContributed=true;
  };
  const close=()=>closing??=(async()=>{
    phase='stopped';stopPoll();
    workflows?.quiesce();
    const errors:unknown[]=[];
    try{await inflight;}catch{/* accepted failures remain in the engine receipt */}
    const fileProcessing=processing;processing=undefined;
    try{await fileProcessing?.settle();}catch(error){errors.push(error);}
    contributionsInstalled=false;
    const runtime=workflows;workflows=undefined;
    try{await runtime?.close();}catch(error){errors.push(error);}
    restoreSourceContext();
    phase='disposed';
    if(errors.length)throw new AggregateError(errors,'Processing services disposal failed');
  })();
  const port:ProcessingServicesPort=Object.freeze({
    get phase(){return phase;},
    enqueue:(steps:Parameters<ProcessingRuntime['enqueue']>[0])=>writable().enqueue(steps),
    view:(args?:Parameters<ProcessingRuntime['view']>[0])=>read().view(args),
    save:(input:unknown)=>writable().save(input),
    retry:(id:string)=>writable().retry(id),
    cancel:(id:string)=>read().cancel(id),
  });
  return Object.freeze({
    port,
    get workflows(){if(!workflows||phase==='created'||phase==='disposed')throw unavailable();return workflows;},
    get processing(){if(!processing||phase==='created'||phase==='disposed')throw unavailable();return processing;},
    /** Construct this activation's domain objects and install its file
     * capabilities. A mid-prepare failure closes both partially constructed
     * owners and rolls back the contribution set. */
    async prepare(scope?:Pick<PluginScope,'defer'>){
      if(phase!=='created')throw unavailable();
      try{
        workflows=new ProcessingRuntime(dependencies.store,[],{},Date.now,dependencies.executor,dependencies.materials,dependencies.backendContext,dependencies.configService);
        dependencies.sourcePipelines.setProductConsumer(workflows);
        workflows.consumerAllowed=(sourceId,bindingId)=>dependencies.sourcePipelines.options(sourceId).consumers.includes(bindingId);
        processing=new FileProcessing(dependencies.files,dependencies.transcriptionProvider,undefined,{
          modelAuthority:dependencies.modelAuthority,configService:dependencies.configService,executor:dependencies.executor,
          modules:[...dependencies.modules],builtinContributions:false,analyze:dependencies.analyze,analysisSnapshot:dependencies.analysisSnapshot,
          analysisRevision:dependencies.analysisRevision,diagnostics:dependencies.diagnostics,contextProcessors:workflows.registry,
          pluginContext:dependencies.backendContext,mediaAssets:dependencies.mediaAssets,media:dependencies.media,
          contextForEvidence:record=>dependencies.materials.contextForEvidence(record),
        });
        installContributions();
        scope?.defer(removeContributions);
        previousSourceContextChanged=dependencies.materials.onSourceContextChanged;
        dependencies.materials.onSourceContextChanged=relay;
        await workflows.ready;
        await processing.initializeConfiguration();
        phase='prepared';
      }catch(error){
        try{await close();}
        catch(cleanup){throw new AggregateError([error,cleanup],'Processing services preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){
      if(phase==='active')return;
      if((phase==='prepared'||phase==='stopped')&&workflows){
        installContributions();
        workflows.resume();
        phase='active';startPoll();return;
      }
      throw unavailable();
    },
    quiesce(_reason?:StopReason){
      if(phase!=='active')return;
      phase='quiescing';stopPoll();
      // Accepted jobs stay committable; only new submissions are fenced.
      workflows?.quiesce();
    },
    stop:async(_reason?:StopReason)=>{
      if(phase==='stopped'||phase==='disposed')return;
      if(phase==='created'){phase='stopped';return;}
      phase='quiescing';stopPoll();
      workflows?.quiesce();
      // Drain the poll that already claimed intake for this activation.
      try{await inflight;}catch{/* the next explicit start re-observes durable work */}
      removeContributions();
      phase='stopped';
    },
    dispose:close,
    close,
    tick(){return phase==='active'?runPoll():Promise.resolve();},
    contributeRoutes,
    routes,
  });
}

export function createProcessingServicesFactory(platform:ProcessingServices,onStarted?:(value:ProcessingServicesStarted)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:()=>platform.prepare(context.scope),
      start(){
        platform.start();
        platform.contributeRoutes();
        context.provide(processingServicesContribution.id,centralServices.processing,platform.port);
        onStarted?.({workflows:platform.workflows,processing:platform.processing});
      },
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),
      stop:(reason?:StopReason)=>platform.stop(reason),
      dispose:()=>platform.dispose(),
    };
  };
}
