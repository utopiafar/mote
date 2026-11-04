import type {FastifyInstance} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {Conversations} from '../conversations.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {StoreError} from '../store.js';
type Store=ConstructorParameters<typeof Conversations>[0];
import {registerConversationRoutes} from '../features/ask/conversations.js';
import {centralServices,type ConversationRepository} from './central-contracts.js';

export const conversationsContribution={
  id:'conversations',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'}],
  provides:[{kind:'service' as const,id:centralServices.conversations.id,apiVersion:centralServices.conversations.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const conversationsDeclaration={id:conversationsContribution.id,apiVersion:'1'} as const;
export const conversationsReplacement='hot' as const;

export interface ConversationsBindings {readonly conversations:ServiceBinding;}

const unavailable=()=>new StoreError('Conversations are unavailable',503);

/** Owns conversation storage and its retained-evidence authority. Consumers use
 * the lifecycle-gated port rather than constructing Conversations themselves. */
export function createConversations(store:Store,authorization:Pick<ModelAuthorizationHost,'conversation'>){
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let current:Conversations|undefined,closing:Promise<void>|undefined;
  const read=()=>{
    if(!current||!['prepared','active','quiescing'].includes(phase))throw unavailable();
    return current;
  };
  const write=()=>{
    if(!current||phase!=='active')throw unavailable();
    return current;
  };
  const conversations:ConversationRepository=Object.freeze({
    list:(args?:Parameters<Conversations['list']>[0])=>read().list(args),
    get:(id:string)=>read().get(id),
    page:(id:string,args?:Parameters<Conversations['page']>[1])=>read().page(id,args),
    referenceAvailability:(id:string,evidenceId:string)=>read().referenceAvailability(id,evidenceId),
    append:(previous:Parameters<Conversations['append']>[0],input:Parameters<Conversations['append']>[1],result:Parameters<Conversations['append']>[2])=>write().append(previous,input,result),
    appendFailure:(previous:Parameters<Conversations['appendFailure']>[0],input:Parameters<Conversations['appendFailure']>[1],error:Parameters<Conversations['appendFailure']>[2])=>write().appendFailure(previous,input,error),
    delete:(id:string)=>write().delete(id),
    context:(conversation:Parameters<Conversations['context']>[0],maxTurns?:number,maxCharacters?:number)=>read().context(conversation,maxTurns,maxCharacters),
    historyContext:(conversation:Parameters<Conversations['historyContext']>[0],turns?:Parameters<Conversations['historyContext']>[1])=>read().historyContext(conversation,turns),
    assertHistoryContext:(snapshot:Parameters<Conversations['assertHistoryContext']>[0])=>read().assertHistoryContext(snapshot),
    retiredSelection:(snapshot:Parameters<Conversations['retiredSelection']>[0],ids:readonly string[])=>read().retiredSelection(snapshot,ids),
  });
  const close=()=>closing??=(async()=>{phase='stopped';current=undefined;})();
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{
        current=new Conversations(store);
        current.onTurnReceived=turnId=>authorization.conversation(turnId);
        phase='prepared';
      }catch(error){
        try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Conversation preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    conversations,
  });
}
export type ConversationsPlatform=ReturnType<typeof createConversations>;

/** Stable pre-H14 route table. A new activation replaces the port without
 * installing another copy of the conversation routes. */
export function createConversationRoutes(){
  let current:ConversationRepository|undefined;
  const mounted=new WeakSet<FastifyInstance>();
  return Object.freeze({
    activate(conversations:ConversationRepository){current=conversations;},
    mount(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Conversation routes are already installed',409);
      mounted.add(app);
      app.register(async child=>registerConversationRoutes(child,()=>{
        if(!current)throw unavailable();
        return current;
      }));
    },
  });
}
export type ConversationRoutes=ReturnType<typeof createConversationRoutes>;

export function createConversationsFactory(platform:ConversationsPlatform,onStarted?:(bindings:ConversationsBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const conversations=context.provide(conversationsContribution.id,centralServices.conversations,platform.conversations);
        onStarted?.({conversations});
      },
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
