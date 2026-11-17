import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {QueryInput} from '@mote/agent';
import type {ActionPluginProvider,CaptureRecord,CentralConnectorActionTarget,ConnectorActionExecution,ConnectorActionReceipt,QueryResult} from '@mote/shared';
import {Actions,registerActions} from './actions.js';
import {ActionCapabilities} from './plugins/action-capabilities.js';
import {registerActionCapabilityRoutes} from './plugins/action-capability-routes.js';
import {ManagedCalendar} from './managed-calendar.js';
import {TodoStore,registerTodoRoutes} from './todos.js';
import {AssistantActions,registerAssistantActionRoutes} from './assistant-actions.js';
import {OwnerCalendarInstructions,type OwnerCalendarAuthority} from './owner-calendar-instructions.js';
import {StoreError,type Store} from './store.js';
import type {ActionsDomain,ActionsServicesInputs} from './plugins/actions-services.js';
import type {FileStore} from './files.js';
import type {SourceStore} from './sources.js';
import type {Connections,ConnectionCredential} from './connections.js';
import type {ConfigService} from './config-service.js';
import type {ExecutionEngine} from './execution-engine.js';
import type {AssistantTasks} from './assistant-tasks.js';

/** Private persistence/transport adapter. Only the deferred open operation is
 * published to the plugin. The raw Actions handoff stays confined to trusted
 * assembly until its remaining consumers migrate to domain ports. */
export interface ActionsInputDependencies {
  readonly store:Store;readonly files:FileStore;readonly sources:SourceStore;readonly connections:Connections;readonly executor:ExecutionEngine;
  readonly actionProviders:()=>ActionPluginProvider[];
  readonly connectorAction?:(input:{target:CentralConnectorActionTarget;request:ConnectorActionExecution})=>Promise<ConnectorActionReceipt>;
  readonly query:(input:QueryInput)=>Promise<QueryResult>;readonly configured:()=>boolean;
  readonly assistantTasks?:Pick<AssistantTasks,'actionSource'|'actionCurrent'>;
  readonly readEvidence?:(ids:string[])=>CaptureRecord[];readonly currentEvidence?:(id:string)=>boolean;
  readonly semanticArtifacts?:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  readonly configService?:ConfigService;
  readonly ownerCalendarAuthority?:OwnerCalendarAuthority;
  readonly authorization:{credential:(request:FastifyRequest)=>ConnectionCredential|undefined;connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined};
}

export function createActionsServiceInputs(deps:ActionsInputDependencies){
  let assemblyActions:Actions|undefined;
  const inputs:ActionsServicesInputs=Object.freeze({async open():Promise<ActionsDomain>{
    if(assemblyActions)throw new StoreError('Actions domain is already open',409);
    let actions:Actions|undefined,closed=false,closing:Promise<void>|undefined;
    const pending=new Set<Promise<void>>();
    const close=()=>closing??=(async()=>{
      closed=true;
      const results=await Promise.allSettled([actions?.close(),...pending]);
      if(assemblyActions===actions)assemblyActions=undefined;
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      if(errors.length)throw new AggregateError(errors,'Actions domain disposal failed');
    })();
    try{
      if(deps.store.db.isTransaction)throw new StoreError('Actions services preparation requires an idle vault transaction',503);
      let capabilities:ActionCapabilities|undefined,assistant:AssistantActions|undefined,ownerCalendar:OwnerCalendarInstructions|undefined;
      actions=new Actions(deps.store,deps.files,deps.query,deps.configured,{executor:deps.executor,semanticArtifacts:deps.semanticArtifacts,configService:deps.configService,
        connectorTargets:()=>capabilities?.centralConnectors()??[],messageSendAuthorized:target=>capabilities?.messageSendGranted(target)??false,
        proposalCurrent:id=>assistant?.current(id)??true,ownerInstructionCurrent:action=>ownerCalendar?.current(action)??false,readEvidence:deps.readEvidence,currentEvidence:deps.currentEvidence});
      const current=actions,todos=new TodoStore(deps.store,id=>assistant?.currentTodo(id)??true);
      capabilities=new ActionCapabilities(deps.store,deps.sources,deps.connections,deps.actionProviders);
      const currentCapabilities=capabilities,managed=new ManagedCalendar(deps.store,current,currentCapabilities,deps.connections,deps.connectorAction);
      if(deps.ownerCalendarAuthority){ownerCalendar=new OwnerCalendarInstructions(deps.store,current,deps.ownerCalendarAuthority,target=>currentCapabilities.resolveCentralTarget(target)?.identity);ownerCalendar.recover();}
      if(deps.assistantTasks)assistant=new AssistantActions(deps.store,deps.assistantTasks,current,todos,managed);
      const tickManaged=()=>{
        if(closed)return Promise.resolve();
        const work=managed.tick();pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
      };
      assemblyActions=current;
      return Object.freeze({
        ...(ownerCalendar?{ownerCalendar:{
          offerOwnerCalendar:ownerCalendar.offer.bind(ownerCalendar),proposeOwnerCalendar:ownerCalendar.propose.bind(ownerCalendar),acceptOwnerCalendar:ownerCalendar.accept.bind(ownerCalendar),
          wakeOwnerCalendar(id:string){
            // This callback may be requested inside the query transaction. It
            // reads the durable accepted receipt only after that synchronous
            // transaction returned; rollback leaves no executable Action.
            queueMicrotask(()=>{if(!closed&&!deps.store.db.isTransaction&&ownerCalendar!.accepted(id))void tickManaged().catch(()=>{});});
          },
        }}:{}),
        async tick(){if(closed)throw new StoreError('Actions services are unavailable',503);await current.tick();if(!closed)await tickManaged();},
        routes(app:FastifyInstance){
          registerActions(app,current,deps.connections,deps.authorization.credential,()=>{void tickManaged().catch(()=>{});},request=>{const identity=deps.authorization.connectionIdentity(request);return !identity||deps.connections.isOwner(identity);});
          registerTodoRoutes(app,todos);
          registerActionCapabilityRoutes(app,{capabilities:currentCapabilities,managed,connections:deps.connections,connectionIdentity:deps.authorization.connectionIdentity});
          if(assistant)registerAssistantActionRoutes(app,assistant,request=>{
            const identity=deps.authorization.connectionIdentity(request);
            if(identity&&!deps.connections.isOwner(identity))throw new StoreError('Only the owner can create assistant actions',403);
            if(identity)deps.connections.assertActive(identity);
          });
        },close,
      });
    }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Actions domain preparation and disposal failed',{cause:error});}throw error;}
  }});
  return Object.freeze({inputs,get actionsForAssembly(){if(!assemblyActions)throw new StoreError('Actions services are unavailable',503);return assemblyActions;}});
}
