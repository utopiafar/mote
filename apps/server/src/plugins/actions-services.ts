import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {QueryInput} from '@mote/agent';
import type {ActionPluginProvider,CentralConnectorActionTarget,ConnectorActionExecution,ConnectorActionReceipt,QueryResult} from '@mote/shared';
import {Actions,registerActions} from '../actions.js';
import {ActionCapabilities} from './action-capabilities.js';
import {registerActionCapabilityRoutes} from './action-capability-routes.js';
import {ManagedCalendar} from '../managed-calendar.js';
import {TodoStore,registerTodoRoutes} from '../todos.js';
import {StoreError} from '../store.js';
import type {FileStore} from '../files.js';
import type {SourceStore} from '../sources.js';
import type {Connections,ConnectionCredential} from '../connections.js';
import type {ConfigService} from '../config-service.js';
import type {ExecutionEngine} from '../execution-engine.js';
import {AssistantActions,registerAssistantActionRoutes} from '../assistant-actions.js';
import type {AssistantTasks} from '../assistant-tasks.js';
import type {CaptureRecord} from '@mote/shared';

/** C25 owns the action domain: durable proposals, the todo store, owner action
 * capability grants and the managed calendar delivery/claim/receipt channel.
 * Route handlers dispatch on the current activation; without an active one the
 * mounted contribution answers 503 and never re-registers on re-enable. */
export const actionsServicesContribution={
  id:'actions-services',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host' as const,id:'mote.vault-platform',version:'1.0.0'}],
  provides:[],
} as const satisfies ManifestContribution;
export const actionsServicesDeclaration={id:actionsServicesContribution.id,apiVersion:'1'} as const;
export const actionsServicesReplacement='hot' as const;

const unavailable=()=>new StoreError('Actions services are unavailable',503);
const pollIntervalMs=15000;
const writeMethod=(method:string)=>method==='POST'||method==='PUT'||method==='PATCH'||method==='DELETE';

export interface ActionsServicesDependencies {
  readonly store:Actions['store'];
  readonly files:FileStore;
  readonly sources:SourceStore;
  readonly connections:Connections;
  readonly executor:ExecutionEngine;
  readonly actionProviders:()=>ActionPluginProvider[];
  /** Host-owned dispatch to an enabled Central connector instance. */
  readonly connectorAction?:(input:{target:CentralConnectorActionTarget;request:ConnectorActionExecution})=>Promise<ConnectorActionReceipt>;
  readonly query:(input:QueryInput)=>Promise<QueryResult>;
  readonly configured:()=>boolean;
  readonly assistantTasks?:Pick<AssistantTasks,'actionSource'|'actionCurrent'>;
  readonly readEvidence?:(ids:string[])=>CaptureRecord[];
  readonly currentEvidence?:(id:string)=>boolean;
  readonly semanticArtifacts?:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  readonly configService?:ConfigService;
  readonly authorization:{
    readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
    readonly connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined;
  };
}

export function createActionsServices(deps:ActionsServicesDependencies){
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let actions:Actions|undefined,todos:TodoStore|undefined,capabilities:ActionCapabilities|undefined,managed:ManagedCalendar|undefined;
  let assistant:AssistantActions|undefined;
  let timer:ReturnType<typeof setInterval>|undefined,inflight:Promise<void>|undefined,closing:Promise<void>|undefined;
  const mounted=new WeakSet<FastifyInstance>();
  const readable=()=>phase==='prepared'||phase==='active'||phase==='quiescing';
  const domain=()=>{
    if(!actions||!todos||!capabilities||!managed||!readable())throw unavailable();
    return {actions,todos,capabilities,managed};
  };
  const clearTimer=()=>{if(timer){clearInterval(timer);timer=undefined;}};
  const close=()=>closing??=(async()=>{
    phase='stopped';clearTimer();
    await inflight?.catch(()=>{});
    try{await actions?.close();}
    finally{actions=undefined;todos=undefined;capabilities=undefined;managed=undefined;assistant=undefined;}
  })();
  /** Mounted once by the feature bridge before listen. The phase hook resolves
   * per request against the current activation, so reads survive quiesce, new
   * writes require an active activation and a stopped owner returns 503 without
   * installing a second route table. */
  const routes=(app:FastifyInstance)=>{
    if(mounted.has(app))throw new StoreError('Actions routes are already installed',409);
    const current=domain();
    mounted.add(app);
    app.register(async child=>{
      child.addHook('onRequest',async(request,reply)=>{
        if(writeMethod(request.method)?phase!=='active':!readable())return reply.code(503).send({error:'feature_unavailable'});
      });
      registerActions(child,current.actions,deps.connections,deps.authorization.credential,()=>void current.managed.tick().catch(()=>{}),request=>{const identity=deps.authorization.connectionIdentity(request);return !identity||deps.connections.isOwner(identity);});
      registerTodoRoutes(child,current.todos);
      registerActionCapabilityRoutes(child,{capabilities:current.capabilities,managed:current.managed,connections:deps.connections,connectionIdentity:deps.authorization.connectionIdentity});
      if(assistant)registerAssistantActionRoutes(child,assistant,request=>{
        const identity=deps.authorization.connectionIdentity(request);
        if(identity&&!deps.connections.isOwner(identity))throw new StoreError('Only the owner can create assistant actions',403);
        if(identity)deps.connections.assertActive(identity);
      });
    });
  };
  return Object.freeze({
    /** Construct the domain objects. A mid-prepare failure closes the partially
     * registered Actions so the borrowed vault, engine handler and timer are
     * released; the same closure stays fenced afterwards. */
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{
        if(deps.store.db.isTransaction)throw new StoreError('Actions services preparation requires an idle vault transaction',503);
        actions=new Actions(deps.store,deps.files,deps.query,deps.configured,{executor:deps.executor,semanticArtifacts:deps.semanticArtifacts,configService:deps.configService,connectorTargets:()=>capabilities?.centralConnectors()??[],messageSendAuthorized:target=>capabilities?.messageSendGranted(target)??false,
          proposalCurrent:id=>assistant?.current(id)??true,readEvidence:deps.readEvidence,currentEvidence:deps.currentEvidence});
        todos=new TodoStore(deps.store,id=>assistant?.currentTodo(id)??true);
        capabilities=new ActionCapabilities(deps.store,deps.sources,deps.connections,deps.actionProviders);
        managed=new ManagedCalendar(deps.store,actions,capabilities,deps.connections,deps.connectorAction);
        if(deps.assistantTasks)assistant=new AssistantActions(deps.store,deps.assistantTasks,actions,todos,managed);
        phase='prepared';
      }catch(error){
        try{await close();}
        catch(cleanup){throw new AggregateError([error,cleanup],'Actions services preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    /** Start the proposal poll; only an active activation accepts or schedules work. */
    start(){
      if(phase!=='prepared')throw unavailable();
      phase='active';
      timer=setInterval(()=>{
        if(phase!=='active'||inflight)return;
        const current=actions,currentManaged=managed;if(!current||!currentManaged)return;
        inflight=(async()=>{await current.tick();await currentManaged.tick();})();
        void inflight.catch(()=>{}).finally(()=>{inflight=undefined;});
      },pollIntervalMs);
      timer.unref?.();
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';clearTimer();},
    async stop(_reason?:StopReason){await close();},
    dispose:close,close,routes,
    /** Trusted assembly bridge for `node.actions`; fenced once the activation ends. */
    get actionsForAssembly(){if(!actions||phase==='created'||phase==='stopped')throw unavailable();return actions;},
  });
}
export type ActionsServices=ReturnType<typeof createActionsServices>;

export function createActionsServicesFactory(platform:ActionsServices){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start:()=>platform.start(),
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),
      stop:(reason?:StopReason)=>platform.stop(reason),
      dispose:platform.dispose,
    };
  };
}
