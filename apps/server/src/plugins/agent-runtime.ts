import type {FastifyInstance} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {AgentOptions} from '@mote/agent';
import {z} from 'zod';
import {AgentRuntimeRegistry,type AgentRuntimeRegistryDependencies} from '../agent-runtime-registry.js';
import type {ConcurrencyGate} from '../concurrency.js';
import type {Config} from '../config.js';
import type {ConfigService} from '../config-service.js';
import {serverConfiguration} from '../configuration.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {ExecutionSettings} from '../execution-settings.js';
import {moteText} from '../i18n.js';
import type {MaintenanceWorker} from '../maintenance.js';
import type {LifecycleSettings} from '../memory-lifecycle.js';
import {ModelSettingsError,type ModelDomain,type ModelSettingsStore} from '../model-settings.js';
import type {ProviderAdmission} from '../provider-admission.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';
import {registerAgentRuntimeSettingsRoutes} from './agent-runtime-settings-routes.js';
import {registerExecutionSettingsRoutes} from './execution-settings-routes.js';
import {registerModelSettingsRoutes} from './model-settings-routes.js';

/** A09's model runtime registry owns model-agent factories, prepared/retired
 * model generations and the mote.models configuration/model settings route
 * table. Model selection authority stays with C03/C04. */
export const agentRuntimeContribution={
  id:'agent-runtime',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.configuration.id,version:'1.0.0'},
    {kind:'service',id:centralServices.modelAuthority.id,version:'1.0.0'},
    {kind:'service',id:centralServices.modelAdmission.id,version:'1.0.0'},
  ],
  provides:[],
} as const satisfies ManifestContribution;
export const agentRuntimeDeclaration={id:agentRuntimeContribution.id,apiVersion:'1'} as const;
/** Model generations are in-memory: a stopped activation drains them, and the
 * next process activation re-binds model settings from durable configuration. */
export const agentRuntimeReplacement='restart' as const;

/** Route-table dependencies outside this domain stay late-bound: config
 * transactions, memory wake-up and lifecycle policy resolve per request. */
export interface AgentRuntimeRouteDependencies {
  readonly modelSettings:()=>ModelSettingsStore;
  readonly configService:ConfigService;
  readonly runtimeSettings:ExecutionSettings;
  readonly insightSettings:()=>LifecycleSettings['insights'];
  readonly providerAdmission:ProviderAdmission;
  readonly maintenanceSnapshot:()=>ReturnType<MaintenanceWorker['snapshot']>|null;
  readonly delegatedSnapshot:()=>ReturnType<ExecutionEngine['poolSnapshot']>;
  readonly wakeMemory:()=>void;
}

export interface AgentRuntimeServicesDependencies {
  readonly config:Config;
  readonly diagnostics:ServerDiagnostics;
  /** Registry inputs except codex and the two execution gates, which this
   * plugin also publishes on its own route surface. */
  readonly registry:Omit<AgentRuntimeRegistryDependencies,'codex'|'agentGate'|'interactiveGate'>;
  readonly agentGate:ConcurrencyGate;
  readonly llmGate:ConcurrencyGate;
  readonly interactiveGate:ConcurrencyGate;
  readonly interactiveModelGate:ConcurrencyGate;
  readonly onCloseError:(error?:unknown)=>void;
  readonly routes:AgentRuntimeRouteDependencies;
}

export interface AgentRuntimeServices extends PluginLifecycle {
  /** The live model generation registry; one identity per activation. */
  readonly agent:AgentRuntimeRegistry;
  readonly codex:NonNullable<AgentOptions['codex']>;
  /** Mount the mote.models HTTP table once, before Fastify listen. */
  routes(app:FastifyInstance):void;
  dispose():Promise<void>;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Agent runtime services are unavailable',503);

function retainedCredential(current:unknown,patch:unknown):boolean {
  if(!current)return false;
  if(current&&typeof current==='object'&&!Array.isArray(current)){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))return Object.keys(current).length>0;
    return Object.entries(current).some(([key,value])=>!Object.hasOwn(patch,key)||retainedCredential(value,(patch as Record<string,unknown>)[key]));
  }
  return patch===undefined;
}
/** Generic model edits preserve the same credential-reuse decision as the dedicated model editor. */
function checkModelCredentialReuse(saved:ModelDomain,patch:Record<string,unknown>,allow:boolean):void {
  if(allow)return;
  const deployment=patch.deployment;
  if(deployment&&typeof deployment==='object'&&!Array.isArray(deployment)){
    const next=deployment as Record<string,unknown>,current=saved.deployment;
    const changed=['provider','protocol','baseUrl'].some(key=>Object.hasOwn(next,key)&&next[key]!==current[key as keyof typeof current]);
    if(changed&&['apiKey','headers','extraBody'].some(key=>retainedCredential(current[key as keyof typeof current],next[key])))throw new ModelSettingsError('model_settings_credential_reuse');
  }
  const embedding=patch.embedding;
  if(embedding&&typeof embedding==='object'&&!Array.isArray(embedding)){
    const next=embedding as Record<string,unknown>;
    if(Object.hasOwn(next,'baseUrl')&&next.baseUrl!==saved.embedding.baseUrl&&saved.embedding.apiKey&&!Object.hasOwn(next,'apiKey'))throw new ModelSettingsError('model_settings_credential_reuse');
  }
}

/** The registry, its codex options and every prepared/retired model generation
 * live only inside this plugin scope. A stop drains the registry's generations;
 * durable model settings stay in C03 and re-bind on the next activation. */
export function createAgentRuntimeServices(dependencies:AgentRuntimeServicesDependencies):AgentRuntimeServices {
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let runtime:AgentRuntimeRegistry|undefined,codex:NonNullable<AgentOptions['codex']>|undefined,closing:Promise<void>|undefined;
  const mounted=new WeakSet<FastifyInstance>();
  const opened=()=>{if(!runtime)throw unavailable();return runtime;};
  const closeRuntime=async()=>{const owned=runtime;runtime=undefined;if(owned)await owned.close();};
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    phase='disposed';
    try{await closeRuntime();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Agent runtime disposal failed');
  })();
  return Object.freeze({
    get agent(){return opened();},
    get codex(){if(!codex)throw unavailable();return codex;},
    prepare(){
      if(phase!=='created')throw unavailable();
      codex={executable:dependencies.config.codexBin,home:dependencies.config.codexHome};
      try{
        runtime=new AgentRuntimeRegistry({...dependencies.registry,codex,agentGate:dependencies.agentGate,interactiveGate:dependencies.interactiveGate},dependencies.onCloseError);
      }catch(error){codex=undefined;throw error;}
      phase='prepared';
    },
    start(){
      if(phase==='active')return;
      if(phase!=='prepared')throw unavailable();
      phase='active';
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    async stop(_reason?:StopReason){
      if(phase==='stopped'||phase==='disposed')return;
      phase='stopped';
      await closeRuntime();
    },
    dispose:close,
    close,
    /** Mounted once by the mote.models feature bridge. Every request resolves
     * the current activation; stopping and re-enabling never adds a route. */
    routes(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Agent runtime routes are already installed',409);
      if(phase==='created'||phase==='stopped'||phase==='disposed')throw unavailable();
      mounted.add(app);
      const {config,routes}=dependencies;
      const modelSettings=routes.modelSettings();
      app.register(async child=>{
        child.addHook('onRequest',async(request,reply)=>{
          if(phase==='active'||phase==='quiescing'&&request.method==='GET')return;
          return reply.code(503).send({error:'feature_unavailable'});
        });
        registerModelSettingsRoutes(child,modelSettings,codex);
        registerAgentRuntimeSettingsRoutes(child,{agent:opened(),modelSettings,configService:routes.configService});
        const configurationView=()=>{const d=routes.runtimeSettings.diagnostics(),view=serverConfiguration({...config,...routes.runtimeSettings.execution(),diagnosticsEnabled:d.enabled,diagnosticsDebug:d.debug,agentTraceEnabled:d.traceEnabled,logLevel:d.level},{modelSource:modelSettings.view().source,service:routes.configService.view()}),policy=routes.insightSettings(),field=view.groups.flatMap(g=>g.fields).find(f=>f.key==='insightIntervalHours');if(field){field.value=policy.enabled?policy.intervalHours:0;field.source='derived';field.description=moteText("已保存的洞察策略：周期到达并且至少 {0} 次增量变化时运行。在记忆设置中直接修改。", policy.minChanges);delete field.envVar;}return view;};
        child.get('/api/configuration',async()=>configurationView());
        child.put('/api/configuration/:id',{bodyLimit:1048576},async req=>{const {id}=z.object({id:z.string().min(1).max(128)}).parse(req.params),body=z.object({revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),value:z.record(z.unknown()),allowCredentialReuse:z.boolean().optional()}).strict().parse(req.body);if(id==='models')checkModelCredentialReuse(routes.configService.saved<ModelDomain>('models'),body.value,body.allowCredentialReuse===true);await routes.configService.update(id,body.value,body.revision);return configurationView();});
        registerExecutionSettingsRoutes(child,{runtimeSettings:routes.runtimeSettings,agentGate:dependencies.agentGate,llmGate:dependencies.llmGate,interactiveGate:dependencies.interactiveGate,interactiveModelGate:dependencies.interactiveModelGate,diagnostics:dependencies.diagnostics,providerAdmission:routes.providerAdmission,maintenanceSnapshot:routes.maintenanceSnapshot,delegatedSnapshot:routes.delegatedSnapshot,wakeMemory:routes.wakeMemory});
      });
    },
  });
}
export type AgentRuntimePlatform=ReturnType<typeof createAgentRuntimeServices>;

/** Native host factory. The pre-H14 bridge mounts the same route contribution
 * through `moteDomainRoutes`; both paths share one actual registry instance. */
export function createAgentRuntimeFactory(dependencies:AgentRuntimeServicesDependencies){
  return (context:HostPluginContext):PluginLifecycle&{routes:AgentRuntimeServices['routes'];agent:AgentRuntimeRegistry;codex:NonNullable<AgentOptions['codex']>}=>{
    const services=createAgentRuntimeServices(dependencies);
    context.scope.defer(()=>services.close());
    return Object.freeze({
      prepare:services.prepare,start:services.start,quiesce:services.quiesce,stop:services.stop,dispose:services.dispose,routes:services.routes,
      get agent(){return services.agent;},get codex(){return services.codex;},
    });
  };
}
