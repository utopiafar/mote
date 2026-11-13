import {randomUUID} from 'node:crypto';
import {
  assistantDraftCommandSchema,
  assistantDraftSchema,
  queryScopeSchema,
  type AssistantDraft,
  type AssistantDraftCapability,
  type AssistantDraftCommand,
  type QueryScope,
} from '@mote/shared';
import type {ConversationTurn} from './conversations.js';
import type {ConversationRepository} from './plugins/central-contracts.js';
import {StoreError} from './store.js';

/** Flat host scope used by the accepted query. Anchored questions cannot be
 * represented by the shared task scope, so the host offers no draft for them. */
export type AssistantDraftScopeInput = {
  after?:string;before?:string;deviceId?:string;timeZone?:string;
  sourceIds?:string[];evidenceIds?:string[];anchorEvidenceIds?:string[];anchorMaterialRef?:string;
};
export function assistantDraftScope(input:AssistantDraftScopeInput):QueryScope|undefined {
  if(input.anchorMaterialRef||input.anchorEvidenceIds?.length)return undefined;
  const filters={
    ...(input.after?{after:input.after}:{}),...(input.before?{before:input.before}:{}),
    ...(input.deviceId?{deviceId:input.deviceId}:{}),...(input.timeZone?{timeZone:input.timeZone}:{}),
  };
  const parsed=queryScopeSchema.safeParse(input.evidenceIds!==undefined||input.sourceIds!==undefined
    ?{kind:'selection',...(input.evidenceIds!==undefined?{evidenceIds:[...input.evidenceIds]}:{}),...(input.sourceIds!==undefined?{sourceIds:[...input.sourceIds]}:{}),...filters}
    :{kind:'all',...filters});
  return parsed.success?parsed.data:undefined;
}

export interface AssistantDraftCommandContext {
  readonly command:AssistantDraftCommand;
  readonly draft:AssistantDraft;
  readonly conversationId:string;
  readonly turnId:string;
  readonly turn:ConversationTurn;
}
export type AssistantDraftCommandHandler=(context:AssistantDraftCommandContext)=>unknown|Promise<unknown>;

/** Answer drafts are stored with their conversation turn, not in a second task
 * store. This service only validates the command envelope and dispatches to
 * domain owners; the task service owns the actual creation and acceptance receipt. */
export class AssistantDrafts {
  private readonly handlers=new Map<AssistantDraftCapability,AssistantDraftCommandHandler>();
  private validateVersion?:(context:AssistantDraftCommandContext)=>void;
  constructor(private readonly conversations:Pick<ConversationRepository,'get'|'referenceAvailability'>){
    // Preview is the side-effect-free command available before a task service.
    this.register('assistant.task.preview',({command,draft})=>({
      requestId:command.requestId,revision:command.expectedRevision,capability:command.capability,
      goal:command.goal,scope:draft.scope,state:'previewed' as const,
    }));
  }

  capabilities():AssistantDraftCapability[]{
    return (['assistant.task.start','assistant.task.preview'] as const).filter(capability=>this.handlers.has(capability));
  }

  register(capability:AssistantDraftCapability,handler:AssistantDraftCommandHandler):()=>void{
    if(this.handlers.has(capability))throw new Error('Assistant draft capability is already registered: '+capability);
    this.handlers.set(capability,handler);
    return ()=>{if(this.handlers.get(capability)===handler)this.handlers.delete(capability);};
  }

  setVersionValidator(validate:(context:AssistantDraftCommandContext)=>void){this.validateVersion=validate;}

  issue(input:{goal:string;scope:QueryScope}):AssistantDraft{
    const capabilities=this.capabilities();
    if(!capabilities.length)throw new StoreError('No assistant draft command is available',503);
    return assistantDraftSchema.parse({requestId:randomUUID(),revision:1,goal:input.goal.trim(),scope:input.scope,capabilities});
  }

  async command(raw:unknown):Promise<unknown>{
    const parsed=assistantDraftCommandSchema.parse(raw),command={...parsed,goal:parsed.goal.trim()};
    const conversation=this.conversations.get(command.conversationId);
    const turn=conversation.turns.find(item=>item.id===command.turnId);
    if(!turn||turn.status!=='completed'||!turn.result?.draft)throw new StoreError('Assistant draft not found',404);
    if(turn.evidenceDeleted||turn.evidenceUnavailable)throw new StoreError('Assistant draft evidence is no longer available',409);
    if(turn.evidenceStale)throw new StoreError('Assistant draft is out of date; generate a new one',409);
    const draft=assistantDraftSchema.parse(turn.result.draft);
    const edited=command.expectedRevision>draft.revision;
    if(command.expectedRevision<draft.revision)
      throw new StoreError('Assistant draft changed; reload before continuing',409);
    // An unchanged draft keeps its original request identity. An explicit edit
    // is a new command version and must not collide with the original request.
    if(edited?command.requestId===draft.requestId:command.requestId!==draft.requestId)
      throw new StoreError('Assistant draft request identity does not match this version',409);
    if(edited?command.expectedRevision===draft.revision+1&&command.goal===draft.goal:command.goal!==draft.goal)
      throw new StoreError('Assistant draft changed; reload before continuing',409);
    if(JSON.stringify(command.scope)!==JSON.stringify(draft.scope))
      throw new StoreError('Assistant draft scope does not match the stored answer',409);
    if(!draft.capabilities.includes(command.capability))
      throw new StoreError('This assistant draft does not offer that command',403);
    for(const evidenceId of draft.scope.evidenceIds??[])
      if(!this.conversations.referenceAvailability(command.conversationId,evidenceId).available)
        throw new StoreError('Assistant draft evidence is no longer available',409);
    const handler=this.handlers.get(command.capability);
    if(!handler)throw new StoreError('Assistant draft capability is unavailable',409);
    const context={command,draft,conversationId:command.conversationId,turnId:command.turnId,turn};
    this.validateVersion?.(context);
    return await handler(context);
  }
}
