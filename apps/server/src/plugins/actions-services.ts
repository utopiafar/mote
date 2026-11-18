import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract,type PluginLifecycle,type StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {FastifyInstance} from 'fastify';
import type {CentralDomainPlugin} from '../domain-activation.js';
import {StoreError} from '../evidence-store.js';
import type {OwnerCalendarPort} from '../owner-calendar-instructions.js';
import type {ExternalCalendarPort} from '../external-calendar-contract.js';

/** The input grants one concrete domain factory, never a Store, SQL connection,
 * engine or mutable collection of host services. Resources open only when the
 * selected activation prepares. */
export interface ActionsDomain {
  readonly ownerCalendar?:OwnerCalendarPort;
  readonly externalCalendar?:ExternalCalendarPort;
  tick():Promise<void>;
  routes(app:FastifyInstance):void;
  quiesce?():void;
  close():Promise<void>;
}
export interface ActionsServicesInputs {open():Promise<ActionsDomain>}
export const actionsServicesInputsContract=serviceContract<ActionsServicesInputs>('mote.central.actions-inputs','1');
export const actionsServicesInputsContribution={id:'actions-services-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service',id:actionsServicesInputsContract.id,apiVersion:'1',cardinality:'single'}],
} as const satisfies ManifestContribution;
export const actionsServicesInputsDeclaration={id:actionsServicesInputsContribution.id,apiVersion:'1'} as const;

/** Proposals, Todos, capability grants and managed delivery share this owner. */
export const actionsServicesContribution={
  id:'actions-services',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'service',id:actionsServicesInputsContract.id,version:'1.0.0'}],
  provides:[{kind:'service',id:'mote.central.actions',apiVersion:'1',cardinality:'single'}],
} as const satisfies ManifestContribution;
export const actionsServicesDeclaration={id:actionsServicesContribution.id,apiVersion:'1'} as const;
export const actionsServicesReplacement='hot' as const;

const unavailable=()=>new StoreError('Actions services are unavailable',503);
const pollIntervalMs=15000;
const writeMethod=(method:string)=>method==='POST'||method==='PUT'||method==='PATCH'||method==='DELETE';

export function createActionsServices(inputs:ActionsServicesInputs){
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let domain:ActionsDomain|undefined,timer:ReturnType<typeof setInterval>|undefined;
  let inflight:Promise<void>|undefined,closing:Promise<void>|undefined;
  const mounted=new WeakSet<FastifyInstance>();
  const clearTimer=()=>{if(timer){clearInterval(timer);timer=undefined;}};
  const close=()=>closing??=(async()=>{
    phase='stopped';clearTimer();
    // Abort extraction before joining its accepted poll, so a model waiting for
    // cancellation cannot deadlock shutdown.
    const results=await Promise.allSettled([domain?.close(),inflight]);domain=undefined;
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(errors.length)throw new AggregateError(errors,'Actions services disposal failed');
  })();
  const poll=()=>{
    if(phase!=='active'||!domain)throw unavailable();
    return inflight??=domain.tick().finally(()=>{inflight=undefined;});
  };
  const ownerCalendar=()=>{if(phase!=='active'||!domain?.ownerCalendar)throw unavailable();return domain.ownerCalendar;};
  const externalCalendar=()=>{if(phase!=='active'||!domain?.externalCalendar)throw unavailable();return domain.externalCalendar;};
  const calendarPort:ExternalCalendarPort=Object.freeze({
    target:(...args:Parameters<ExternalCalendarPort['target']>)=>externalCalendar().target(...args),
    create:(...args:Parameters<ExternalCalendarPort['create']>)=>externalCalendar().create(...args),
    receipt:(...args:Parameters<ExternalCalendarPort['receipt']>)=>externalCalendar().receipt(...args),
  });
  return Object.freeze({
    externalCalendar:calendarPort,
    offerOwnerCalendar:(...args:Parameters<OwnerCalendarPort['offerOwnerCalendar']>)=>ownerCalendar().offerOwnerCalendar(...args),
    proposeOwnerCalendar:(...args:Parameters<OwnerCalendarPort['proposeOwnerCalendar']>)=>ownerCalendar().proposeOwnerCalendar(...args),
    acceptOwnerCalendar:(...args:Parameters<OwnerCalendarPort['acceptOwnerCalendar']>)=>ownerCalendar().acceptOwnerCalendar(...args),
    wakeOwnerCalendar:(...args:Parameters<OwnerCalendarPort['wakeOwnerCalendar']>)=>ownerCalendar().wakeOwnerCalendar(...args),
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{domain=await inputs.open();phase='prepared';}
      catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Actions services preparation and disposal failed',{cause:error});}throw error;}
    },
    start(){
      if(phase!=='prepared')throw unavailable();
      phase='active';timer=setInterval(()=>{if(phase==='active')void poll().catch(()=>{});},pollIntervalMs);timer.unref?.();
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';clearTimer();domain?.quiesce?.();},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,poll,
    get available(){return phase==='active';},
    routes(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Actions routes are already installed',409);
      if(!domain||phase==='created'||phase==='stopped')throw unavailable();
      const current=domain;mounted.add(app);
      app.register(async child=>{
        child.addHook('onRequest',async(request,reply)=>{
          if(writeMethod(request.method)?phase!=='active':phase==='created'||phase==='stopped')return reply.code(503).send({error:'feature_unavailable'});
        });
        current.routes(child);
      });
    },
  });
}
export type ActionsServices=ReturnType<typeof createActionsServices>;
export const actionsServicesContract=serviceContract<ActionsServices>('mote.central.actions','1');

export function createActionsServicesFactory(platform:ActionsServices){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {prepare:platform.prepare,start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.dispose};
  };
}

export const actionsServicesPlugin:CentralDomainPlugin=Object.freeze<CentralDomainPlugin>({
  contribution:actionsServicesContribution,declaration:actionsServicesDeclaration,replacement:actionsServicesReplacement,
  activation:{featureId:'mote.actions',requires:{inputs:{provider:actionsServicesInputsContribution.id,service:actionsServicesInputsContract}},
    async create(context,bindings){
      const input=await context.services.acquire(actionsServicesInputsContract,bindings.inputs!);
      context.scope.defer(()=>input.release());
      const service=createActionsServices(input.value),lifecycle=createActionsServicesFactory(service)(context);
      return {...lifecycle,route:{id:'mote.actions',mount:service.routes},
        start(){service.start();context.provide(actionsServicesContribution.id,actionsServicesContract,service);},
      };
    },
  },
});
