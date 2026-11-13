import {AgentNotConfiguredError,type QueryInput} from '@mote/agent';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {InsightSnapshot} from '@mote/shared';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {InsightRuns} from '../insight-runs.js';
import {InsightRuns as InsightRunsStore} from '../insight-runs.js';
import type {InsightResult} from '../insights.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import {modelProfileIdSchema,type ModelSettingsStore} from '../model-settings.js';
import {insightRequestSchema} from '../query-request.js';
import {scopeFields,validRange,type QueryScope} from '../query-scope.js';
import {StoreError} from '../store.js';

/** C26B's actual data-contribution fragment. H03 owns the package Manifest and
 * H05 owns install topology; this plugin owns review runs, snapshots and the
 * complete `/api/insights` transport. */
export const insightServicesContribution={
  id:'insight-services',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[],
} as const satisfies ManifestContribution;
export const insightServicesDeclaration={id:insightServicesContribution.id,apiVersion:'1'} as const;
/** Report history and run receipts are replaceable while the vault stays live. */
export const insightServicesReplacement='hot' as const;

export interface InsightServicesDependencies {
  /** Transitional bridge: the root already owns the durable run manager. */
  readonly runs?:InsightRuns;
  /** Native ownership after app.ts construction moves behind H14/K04. */
  readonly openRuns?:()=>InsightRuns;
  readonly query:(range:QueryScope&{prompt?:string;modelProfileId?:string},onProgress?:QueryInput['onProgress'],signal?:AbortSignal,operationId?:string,snapshot?:InsightSnapshot)=>Promise<InsightResult>;
  readonly modelAuthorization:Pick<ModelAuthorizationHost,'manual'>;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly agent:Pick<AgentRuntimeRegistry,'configuredFor'>;
  readonly modelSettings:Pick<ModelSettingsStore,'select'>;
  readonly isClosing:()=>boolean;
  readonly diagnostics:Pick<ServerDiagnostics,'run'>;
  readonly readHistory:(query:unknown)=>unknown;
  readonly readReport:(id:string)=>unknown;
}
export interface InsightServices extends PluginLifecycle {
  readonly runs:InsightRuns;
  readonly available:boolean;
  /** Mount the owned HTTP contribution once, before Fastify listen. */
  routes(app:FastifyInstance):void;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Insight services are unavailable',503);
const launchSchema=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional(),prompt:z.string().trim().max(8000).optional(),requestId:z.string().uuid()}).strict().refine(validRange,{message:'Invalid time range'});

/** Trusted assembly seam only: the durable run manager is a business object of
 * this domain, not a root-constructed dependency. */
export function openInsightRuns(...args:ConstructorParameters<typeof InsightRunsStore>){return new InsightRunsStore(...args);}

/** A borrowed run manager cannot be closed here: app.ts still defers its
 * close until K04 moves construction. A natively opened manager belongs to
 * this activation and is stopped/closed with it. */
export function createInsightServices(dependencies:InsightServicesDependencies):InsightServices {
  const {runs:borrowed,openRuns}=dependencies;
  if(Boolean(borrowed)===Boolean(openRuns))throw new StoreError('Insight services need exactly one run manager',503);
  if(typeof dependencies.query!=='function'||typeof dependencies.modelAuthorization?.manual!=='function')throw new StoreError('Insight service dependencies are unavailable',503);
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let runs=borrowed,ownsRuns=Boolean(openRuns),mounted=false,closing:Promise<void>|undefined;
  const manager=()=>{
    if(!runs||phase==='created'||phase==='disposed')throw unavailable();
    return runs;
  };
  const cancelActive=()=>{
    const errors:unknown[]=[];
    for(const run of manager().list())if(run.status==='running')try{manager().cancel(run.id);}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Insight run cancellation failed');
  };
  const closeRuns=async()=>{
    const owned=runs;
    if(!owned)return;
    const errors:unknown[]=[];
    try{await owned.stop();}catch(error){errors.push(error);}
    try{await owned.close();}catch(error){errors.push(error);}
    if(ownsRuns)runs=undefined;
    if(errors.length)throw new AggregateError(errors,'Insight run disposal failed');
  };
  const pauseBorrowed=()=>{if(!ownsRuns&&runs)runs.pause();};
  const stop=async()=>{
    if(phase==='created'||phase==='stopped'||phase==='disposed')return;
    phase='quiescing';
    pauseBorrowed();
    const errors:unknown[]=[];
    try{cancelActive();}catch(error){errors.push(error);}
    if(ownsRuns)try{await closeRuns();}catch(error){errors.push(error);}
    phase='stopped';
    if(errors.length)throw new AggregateError(errors,'Insight service stop failed');
  };
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    try{await stop();}catch(error){errors.push(error);}
    try{if(runs&&ownsRuns)await closeRuns();}catch(error){errors.push(error);}
    phase='disposed';
    if(errors.length)throw new AggregateError(errors,'Insight service disposal failed');
  })();
  function routes(app:FastifyInstance){
    if(mounted)throw new StoreError('Insight routes are already installed',409);
    if(phase!=='prepared'&&phase!=='active')throw unavailable();
    mounted=true;
    app.register(async child=>{
      child.addHook('onRequest',async(_request,reply)=>{if(phase!=='active')return reply.code(503).send({error:'feature_unavailable'});});
      child.post('/api/insight-runs',async(req,reply)=>{
        const body=launchSchema.parse(req.body);
        const {requestId,...input}=body;
        if(!dependencies.agent.configuredFor(dependencies.modelSettings.select('insight',input.modelProfileId).id))throw new AgentNotConfiguredError();
        if(dependencies.isClosing())throw new StoreError('Central node is shutting down',503);
        return dependencies.modelAuthorization.manual('owner-insight:'+requestId,dependencies.availableModelConnections(),async()=>{
          const run=manager().start(requestId,input,(observe,signal,snapshot)=>dependencies.diagnostics.run(requestId,()=>dependencies.query(input,observe,signal,'insight:'+requestId,snapshot)));
          return reply.code(202).send(run);
        });
      });
      child.post('/api/insight-runs/:id/cancel',async req=>{const id=z.string().uuid().parse((req.params as {id:string}).id);manager().cancel(id);return manager().detail(id);});
      child.get('/api/insight-runs',async()=>({items:manager().list()}));
      child.get('/api/insight-runs/:id',async req=>manager().detail(z.string().uuid().parse((req.params as {id:string}).id)));
      child.post('/api/insights',async req=>{const id=randomUUID(),input=insightRequestSchema.parse(req.body??{});return dependencies.modelAuthorization.manual('owner-insight:'+id,dependencies.availableModelConnections(),()=>manager().perform(id,input,(observe,signal,snapshot)=>dependencies.query(input,observe,signal,'insight:'+id,snapshot)));});
      child.get('/api/insights',async req=>dependencies.readHistory(req.query));
      // A result identity is independent of its background job. Only the current
      // published table is authoritative; job receipts cannot restore deleted results.
      child.get('/api/insights/:runId',async req=>dependencies.readReport(z.string().min(1).max(128).refine(id=>!/[\u0000-\u001f\u007f]/.test(id)).parse((req.params as {runId:string}).runId)));
    });
  }
  return Object.freeze({
    get available(){return phase==='active';},
    prepare(){
      if(phase!=='created')throw unavailable();
      if(openRuns){const created=openRuns();if(!created)throw new StoreError('Insight run manager is unavailable',503);runs=created;ownsRuns=true;}
      phase='prepared';
    },
    start(){
      if(phase==='prepared'){
        // A fresh activation over the same durable manager restores admission;
        // app.ts still owns that manager's final close until K04.
        if(!ownsRuns)manager().resume();
        phase='active';return;
      }
      if(phase==='stopped'){
        if(!ownsRuns){manager().resume();phase='active';return;}
        // A natively owned manager is re-opened from the same durable profile,
        // preserving receipts, fences and the original report history.
        if(!openRuns)throw unavailable();
        const created=openRuns();if(!created)throw new StoreError('Insight run manager is unavailable',503);
        runs=created;phase='active';return;
      }
      throw unavailable();
    },
    quiesce(_reason?:StopReason){if(phase==='active'){phase='quiescing';pauseBorrowed();}},
    stop:async(_reason?:StopReason)=>{await stop();},
    dispose:close,close,
    get runs(){return manager();},
    routes,
  });
}

/** Trusted H14 wiring. The activation owns snapshots/runs; a borrowed manager
 * remains owned by the current root until construction moves here. */
export function createInsightServicesFactory(dependencies:InsightServicesDependencies){
  return (context:HostPluginContext):InsightServices=>{
    const service=createInsightServices(dependencies);
    context.scope.defer(()=>service.close());
    return Object.freeze({
      prepare:()=>service.prepare(),
      start:()=>service.start(),
      quiesce:(reason:StopReason)=>service.quiesce(reason),
      stop:(reason:StopReason)=>service.stop(reason),
      dispose:()=>service.dispose(),
      get available(){return service.available;},
      get runs(){return service.runs;},
      routes:service.routes,
      close:()=>service.close(),
    });
  };
}
