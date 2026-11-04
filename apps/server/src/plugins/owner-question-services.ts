import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {ownerQuestionReplySchema,ownerQuestionStateSchema} from '@mote/shared';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {OwnerQuestions} from '../owner-questions.js';
import {StoreError} from '../store.js';
import {centralServices,type OwnerQuestionsPort} from './central-contracts.js';

/** C26C owns the durable owner-question ledger and its owner-only HTTP table.
 * Memory registers one provider through the shared instance; this plugin never
 * interprets answers or writes a continuation itself. */
export const ownerQuestionServicesContribution={
  id:'owner-question-services',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[{kind:'service',id:centralServices.ownerQuestions.id,apiVersion:centralServices.ownerQuestions.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const ownerQuestionServicesDeclaration={id:ownerQuestionServicesContribution.id,apiVersion:'1'} as const;
/** Durable questions, dependencies and reply receipts survive a stopped activation. */
export const ownerQuestionServicesReplacement='hot' as const;

export interface OwnerQuestionServicesDependencies {
  /** Borrowed vault handle; the question ledger never owns or closes the Store. */
  readonly store:ConstructorParameters<typeof OwnerQuestions>[0];
  /** Non-owner connection present on the request; owner bearer requests have none. */
  readonly credential:(request:FastifyRequest)=>unknown;
  readonly modelAuthorization:Pick<ModelAuthorizationHost,'manual'>;
  readonly availableModelConnections:()=>ModelConnection[];
}

export interface OwnerQuestionServices extends PluginLifecycle {
  readonly questions:OwnerQuestions;
  readonly port:OwnerQuestionsPort;
  /** Mount the owned HTTP table once, before Fastify listen. */
  routes(app:FastifyInstance):void;
  close():Promise<void>;
}

export interface OwnerQuestionRouteDependencies {
  readonly credential:(request:FastifyRequest)=>unknown;
  readonly modelAuthorization:Pick<ModelAuthorizationHost,'manual'>;
  readonly availableModelConnections:()=>ModelConnection[];
  /** Plugin admission: check the active activation and track accepted work. */
  readonly runWrite?:<T>(task:()=>Promise<T>)=>Promise<T>;
}

const unavailable=()=>new StoreError('Owner questions are unavailable',503);

/** The owner-only list, detail and reply transport. Collector credentials and
 * ordinary device connections cannot read or answer. */
export function registerOwnerQuestionRoutes(app:FastifyInstance,questions:OwnerQuestions,dependencies:OwnerQuestionRouteDependencies){
  const owner=(request:FastifyRequest)=>{if(dependencies.credential(request))throw new StoreError('Owner access required',403);};
  const id=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
  app.get('/api/owner-questions',async request=>{owner(request);return questions.page(z.object({state:z.string().transform(value=>value.split(',')).pipe(z.array(ownerQuestionStateSchema).min(1).max(5)).optional(),operationId:z.string().max(512).optional(),operationIds:z.string().transform((value,ctx)=>{try{return JSON.parse(value);}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid operation IDs'});return z.NEVER;}}).pipe(z.array(z.string().min(1).max(512)).min(1).max(100)).optional(),workId:z.string().max(512).optional(),materialId:z.string().max(256).optional(),limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(1000).optional()}).strict().parse(request.query));});
  app.get('/api/owner-questions/:id',async request=>{owner(request);return questions.get(id(request.params));});
  app.post('/api/owner-questions/:id/reply',{bodyLimit:16384},async request=>{
    owner(request);
    const questionId=id(request.params),reply=ownerQuestionReplySchema.parse(request.body);
    const answer=async()=>reply.action==='defer'||reply.action==='unknown'?questions.reply(questionId,reply):dependencies.modelAuthorization.manual('owner-reply:'+questionId+':'+reply.requestId,dependencies.availableModelConnections(),()=>questions.reply(questionId,reply));
    return dependencies.runWrite?dependencies.runWrite(answer):answer();
  });
}

/** Owns one ledger generation. Reads stay available through quiesce; new
 * replies require an active activation, and stop drains the accepted ones
 * before the feature bridge or shutdown closes the route. Re-enabling reopens
 * the same durable profile without rebuilding the ledger or its providers. */
export function createOwnerQuestionServices(dependencies:OwnerQuestionServicesDependencies):OwnerQuestionServices {
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let questions:OwnerQuestions|undefined,closing:Promise<void>|undefined;
  const inflight=new Set<Promise<unknown>>();
  const mounted=new WeakSet<FastifyInstance>();
  const ready=()=>{
    if(!questions||phase==='created'||phase==='disposed')throw unavailable();
    return questions;
  };
  const readable=()=>Boolean(questions)&&(phase==='prepared'||phase==='active'||phase==='quiescing');
  const active=()=>phase==='active';
  const track=<T>(task:()=>Promise<T>)=>{
    if(!active())throw unavailable();
    const result=task(),settled=result.then(()=>undefined,()=>undefined);
    inflight.add(settled);void settled.finally(()=>inflight.delete(settled));
    return result;
  };
  const stop=async()=>{
    if(phase==='stopped'||phase==='disposed')return;
    if(phase==='active'||phase==='prepared')phase='quiescing';
    while(inflight.size)await Promise.allSettled([...inflight]);
    phase='stopped';
  };
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];
    try{await stop();}catch(error){errors.push(error);}
    questions=undefined;phase='disposed';
    if(errors.length)throw new AggregateError(errors,'Owner question disposal failed');
  })();
  const port:OwnerQuestionsPort=Object.freeze({
    register:provider=>ready().register(provider),
    create:(ref,input)=>ready().create(ref,input),
    get:id=>ready().get(id),
    page:args=>ready().page(args),
    reply:(id,reply)=>ready().reply(id,reply),
    obsolete:id=>ready().obsolete(id),
  });
  return Object.freeze({
    get questions(){return ready();},
    port,
    prepare(){
      if(phase!=='created')throw unavailable();
      try{questions=new OwnerQuestions(dependencies.store);phase='prepared';}
      catch(error){questions=undefined;throw error;}
    },
    start(){
      if(phase==='active')return;
      if(phase==='prepared'||phase==='quiescing'||phase==='stopped'){ready();phase='active';return;}
      throw unavailable();
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await stop();},
    dispose:close,close,
    /** Mounted once by the mote.owner-questions feature bridge. Every request
     * resolves the current activation; stopping and re-enabling never adds a
     * route or a second ledger instance. */
    routes(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Owner question routes are already installed',409);
      if(!readable())throw unavailable();
      mounted.add(app);
      app.register(async child=>{
        child.addHook('onRequest',async(request,reply)=>{
          if(!readable())return reply.code(503).send({error:'feature_unavailable'});
          if(request.method!=='GET'&&request.method!=='HEAD'&&!active())return reply.code(503).send({error:'feature_unavailable'});
        });
        registerOwnerQuestionRoutes(child,ready(),{...dependencies,runWrite:track});
      });
    },
  });
}
export type OwnerQuestionServicesPlatform=ReturnType<typeof createOwnerQuestionServices>;

/** Native host factory. The pre-H14 feature bridge mounts the same route
 * contribution through `moteDomainRoutes`; both paths share one ledger. */
export function createOwnerQuestionServicesFactory(dependencies:OwnerQuestionServicesDependencies){
  return (context:HostPluginContext):PluginLifecycle=>{
    const service=createOwnerQuestionServices(dependencies);
    context.scope.defer(()=>service.close());
    return {
      prepare:service.prepare,
      start(){service.start();context.provide(ownerQuestionServicesContribution.id,centralServices.ownerQuestions,service.port);},
      quiesce:service.quiesce,stop:service.stop,dispose:service.dispose,
    };
  };
}
