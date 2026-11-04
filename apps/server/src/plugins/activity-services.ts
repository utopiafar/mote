import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {ActivityProjection,registerActivity,type ActivityDelegationReader} from '../activity.js';
import {AutomaticActivity} from '../automatic-activity.js';
import {StoreError} from '../store.js';
import {registerAgentViewRoutes,type AgentViewRouteDependencies} from './agent-view-routes.js';
import {centralServices} from './central-contracts.js';

/** C26A owns the Activity read projection, the automatic-activity handler/timer
 * and the work-activity plus automatic-activity HTTP table. C26's Agent view
 * read routes are contributed by the same activation. Execution receipts stay
 * owned by C05; this plugin only reads them and registers its own handler. */
export const activityServicesContribution={
  id:'activity-services',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.execution.id,version:'1.0.0'},
    {kind:'service',id:centralServices.materialRead.id,version:'1.0.0'},
  ],
  provides:[],
} as const satisfies ManifestContribution;
export const activityServicesDeclaration={id:activityServicesContribution.id,apiVersion:'1'} as const;
/** Persisted grants, batches and execution steps survive a stopped activation. */
export const activityServicesReplacement='hot' as const;

export interface ActivityServicesDependencies {
  readonly store:ConstructorParameters<typeof ActivityProjection>[0];
  readonly operations:ConstructorParameters<typeof ActivityProjection>[1];
  readonly delegation?:ActivityDelegationReader;
  readonly materials:ConstructorParameters<typeof AutomaticActivity>[1];
  readonly executor:ConstructorParameters<typeof AutomaticActivity>[2];
  readonly config:ConstructorParameters<typeof AutomaticActivity>[3];
  readonly options:ConstructorParameters<typeof AutomaticActivity>[4];
  readonly isCollector:(request:FastifyRequest)=>boolean;
  /** The Agent read projection is part of the same C26 activation. */
  readonly agentView:AgentViewRouteDependencies;
  /** Defaults to the previous processing-feature poll interval. */
  readonly pollIntervalMs?:number;
}

export interface ActivityServices extends PluginLifecycle {
  readonly activity:ActivityProjection;
  readonly automaticActivity:AutomaticActivity;
  /** Mount the owned activity HTTP table once, before Fastify listen. */
  routes(app:FastifyInstance):void;
  /** Mount the Agent view table once; it shares this activation and gate. */
  agentViewRoutes(app:FastifyInstance):void;
  tick():Promise<void>;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Activity services are unavailable',503);

/** A stop closes the automatic-activity handler and intake observer. A later
 * start opens a fresh activation over the same durable profile, so re-enabling
 * never duplicates a handler, timer or already durable activity step. The read
 * projection stays available until dispose/close. */
export function createActivityServices(dependencies:ActivityServicesDependencies):ActivityServices {
  const pollIntervalMs=dependencies.pollIntervalMs??5000;
  if(!Number.isFinite(pollIntervalMs)||pollIntervalMs<=0)throw new RangeError('Invalid activity poll interval');
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let projection:ActivityProjection|undefined,automatic:AutomaticActivity|undefined,poll:ReturnType<typeof setInterval>|undefined,runningPoll=false;
  let closing:Promise<void>|undefined;
  const mounted=new WeakSet<FastifyInstance>(),agentViewMounted=new WeakSet<FastifyInstance>();
  const prepared=()=>{
    if(!projection||!automatic||phase==='created'||phase==='stopped'||phase==='disposed')throw unavailable();
    return {projection,automatic};
  };
  const stopPoll=()=>{if(poll)clearInterval(poll);poll=undefined;};
  const startPoll=()=>{
    if(poll)return;
    poll=setInterval(()=>{
      if(phase!=='active'||runningPoll)return;
      runningPoll=true;
      void automatic!.tick().catch(()=>{}).finally(()=>{runningPoll=false;});
    },pollIntervalMs);
    const timer=poll as unknown as {unref?:()=>unknown};
    timer.unref?.();
  };
  const openAutomatic=()=>{
    if(automatic)throw unavailable();
    return automatic=new AutomaticActivity(dependencies.store,dependencies.materials,dependencies.executor,dependencies.config,dependencies.options);
  };
  const closeAutomatic=async(errors:unknown[])=>{
    const owned=automatic;
    automatic=undefined;
    if(owned)try{await owned.close();}catch(error){errors.push(error);}
  };
  const quiesce=(_reason:StopReason)=>{
    if(phase!=='active')return;
    phase='quiescing';
    stopPoll();
    // Stop prospective intake and fence late model results before accepted work drains.
    automatic?.stop();
  };
  const stop=async()=>{
    if(phase==='stopped'||phase==='disposed')return;
    if(phase==='active'||phase==='prepared')phase='quiescing';
    stopPoll();
    const errors:unknown[]=[];
    try{automatic?.stop();}catch(error){errors.push(error);}
    await closeAutomatic(errors);
    phase='stopped';
    if(errors.length)throw new AggregateError(errors,'Activity service stop failed');
  };
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    try{await stop();}catch(error){errors.push(error);}
    projection=undefined;phase='disposed';
    if(errors.length)throw new AggregateError(errors,'Activity service disposal failed');
  })();
  return Object.freeze({
    get activity(){return prepared().projection;},
    get automaticActivity(){return prepared().automatic;},
    prepare(){
      if(phase!=='created')throw unavailable();
      projection=new ActivityProjection(dependencies.store,dependencies.operations,dependencies.delegation?{delegation:dependencies.delegation}:{});
      try{openAutomatic();}catch(error){
        const owned=automatic;automatic=undefined;
        if(owned)void owned.close();
        projection=undefined;
        throw error;
      }
      phase='prepared';
    },
    start(){
      if(phase==='active')return;
      if(phase==='prepared'){phase='active';startPoll();return;}
      if(phase==='stopped'){
        // Re-read the current configuration and reopen over the same durable
        // grants, batches and execution receipts.
        openAutomatic();
        phase='active';startPoll();return;
      }
      throw unavailable();
    },
    quiesce,
    stop:async(_reason?:StopReason)=>{await stop();},
    dispose:close,
    close,
    tick(){
      if(phase!=='active')return Promise.resolve();
      return automatic!.tick();
    },
    /** Mounted once by the mote.activity feature bridge. Every request resolves
     * the current activation; stopping and re-enabling never adds a route. */
    routes(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Activity routes are already installed',409);
      if(phase==='created'||phase==='stopped'||phase==='disposed')throw unavailable();
      mounted.add(app);
      app.register(async child=>{
        child.addHook('onRequest',async(_request,reply)=>{
          if(phase!=='active')return reply.code(503).send({error:'feature_unavailable'});
        });
        registerActivity(child,prepared().projection,dependencies.isCollector);
        child.get('/api/processing/activity',async()=>prepared().automatic.view());
        child.put('/api/processing/activity',async request=>prepared().automatic.save(request.body));
      });
    },
    /** Mounted once by the mote.agent-view bridge but still owned by this
     * activation, so stopping the activity plugin fences Agent browsing too. */
    agentViewRoutes(app:FastifyInstance){
      if(agentViewMounted.has(app))throw new StoreError('Agent view routes are already installed',409);
      if(phase==='created'||phase==='stopped'||phase==='disposed')throw unavailable();
      agentViewMounted.add(app);
      app.register(async child=>{
        child.addHook('onRequest',async(_request,reply)=>{
          if(phase!=='active')return reply.code(503).send({error:'feature_unavailable'});
        });
        registerAgentViewRoutes(child,dependencies.agentView);
      });
    },
  });
}
export type ActivityServicesPlatform=ReturnType<typeof createActivityServices>;

/** Native host factory. The pre-H14 bridge mounts the same route contribution
 * through `moteDomainRoutes`; both paths share one actual service instance. */
export function createActivityServicesFactory(dependencies:ActivityServicesDependencies){
  return (context:HostPluginContext):PluginLifecycle&{routes:ActivityServices['routes'];agentViewRoutes:ActivityServices['agentViewRoutes']}=>{
    const service=createActivityServices(dependencies);
    context.scope.defer(()=>service.close());
    return Object.freeze({
      prepare:service.prepare,start:service.start,quiesce:service.quiesce,stop:service.stop,dispose:service.dispose,routes:service.routes,agentViewRoutes:service.agentViewRoutes,
    });
  };
}
