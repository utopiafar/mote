import {createHash} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {NativeApplicationContext,NativeApplicationExposure} from '@mote/agent/runtime/dsh';
import type {Conversations} from './conversations.js';
import type {Store} from './store.js';
import {contextFailure} from './model-evidence-authority.js';
import {historyEvidenceDependencies,resolveDependencies} from './conversation-lineage.js';
import type {QueryScope} from './query-scope.js';
import {scopeContainsHistory,scopeFields,validRange} from './query-scope.js';
import {sourceIdSchema} from '@mote/shared';
import {z} from 'zod';

const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const grantScopeSchema=z.object({kind:z.enum(['all','selection']),sourceIds:z.array(sourceIdSchema).optional(),evidenceIds:z.array(z.string().uuid()).optional(),...scopeFields}).strict().refine(validRange)
  .refine(scope=>scope.kind==='all'||scope.sourceIds!==undefined||scope.evidenceIds!==undefined||scope.after!==undefined||scope.before!==undefined||scope.deviceId!==undefined,'A selection needs an explicit restriction');
/** A durable accepted user message, including failed/cancelled runs. Status and
 * the eventual result are mutable; its actual input and membership are not. */
const interactionFingerprint=(message:ReturnType<Conversations['message']>)=>fingerprint([message.question,message.scope,message.attachments??[],message.modelProfileId??null,message.modelOverride??null]);

/** This hook is constructed only on the ordinary admitted query path. It uses
 * the current generic model/evidence policy, not old native permissions. */
export function nativeApplicationContext(input:QueryInput,dependencies:{store:Store;conversations:Pick<Conversations,'message'|'messageForRun'|'assertHistoryContext'|'historyOriginalDependencies'>;assertModelEvidence:(input:QueryInput)=>void;assertCurrent():void}):NativeApplicationContext|undefined {
  const operation=input.traceContext?.operationId;
  if(input.executionLane!=='interactive'||input.skill||!operation?.startsWith('query:')||input.responseMode&&input.responseMode!=='answer')return;
  const {store,conversations,assertModelEvidence}=dependencies,message=conversations.messageForRun(operation.slice(6));
  if(!message||message.question!==input.question)return;
  const requested:QueryScope={kind:message.scope.kind};
  for(const key of ['sourceIds','evidenceIds','after','before','deviceId','timeZone'] as const){const effective=(input as QueryInput&QueryScope)[key]??message.scope[key];if(effective!==undefined)Object.assign(requested,{[key]:structuredClone(effective)});}
  const parsed=grantScopeSchema.safeParse(requested);if(!parsed.success)throw contextFailure('context_lineage_incomplete');const scope=parsed.data;
  const assertExposure=(receipt:NativeApplicationExposure)=>{
    input.signal?.throwIfAborted();dependencies.assertCurrent();input.assertContextAuthority?.();
    const active=conversations.message(message.id);
    if(active.status!=='running'||active.runId!==operation.slice(6))throw contextFailure('context_evidence_restricted');
    if(receipt.version!==1||receipt.evidenceDependencies.version!==1||!receipt.evidenceDependencies.complete)throw contextFailure('context_lineage_incomplete');
    const prior=grantScopeSchema.safeParse(receipt.grantScope);if(!prior.success)throw contextFailure('context_lineage_incomplete');
    if(!scopeContainsHistory(scope,prior.data)||scope.evidenceIds!==undefined&&(prior.data.evidenceIds===undefined||JSON.stringify([...scope.evidenceIds].sort())!==JSON.stringify([...prior.data.evidenceIds].sort())))throw contextFailure('context_evidence_restricted');
    if(receipt.interactionId){
      let current;try{current=conversations.message(receipt.interactionId);}catch{throw contextFailure('context_evidence_restricted');}
      if(current.conversationId!==message.conversationId||interactionFingerprint(current)!==receipt.interactionFingerprint)throw contextFailure('context_evidence_restricted');
    }
    if(receipt.history)conversations.assertHistoryContext(receipt.history);
    for(const pin of receipt.memoryPins){
      const row=store.db.prepare('SELECT json FROM memories WHERE id=?').get(pin.id);
      if(!row)throw contextFailure('context_evidence_restricted');
      const current=JSON.parse(String(row.json));
      if(current.fingerprint!==pin.fingerprint||pin.version!==undefined&&current.version!==pin.version)throw contextFailure('context_evidence_restricted');
    }
    // Keep each Memory closure intact; never split it into ID pages or merge an
    // actual raw body/pixel read into a Memory's retained-body permission.
    assertModelEvidence({question:'',...scope,contextEvidenceDependencies:receipt.evidenceDependencies,contextSourceContextDependencies:[...receipt.sourceContextDependencies]});
    for(const id of receipt.originalEvidenceIds)assertModelEvidence({question:'',...scope,contextEvidenceDependencies:{version:1,complete:true,ids:[id]}});
  };
  const captureExposure=(receipt:NativeApplicationExposure):NativeApplicationExposure=>{
    const history=input.conversation?.historyContext??input.historyContext;
    const originals=history?conversations.historyOriginalDependencies(history):{version:1 as const,complete:true,ids:[]};
    if(!originals.complete)throw contextFailure('context_lineage_incomplete');
    const strict=[...new Set([...receipt.originalEvidenceIds,...originals.ids])];
    // Use the same positive Host delivery roles as ordinary saved dialogue.
    // A Memory-only disclosure retains its exact claim, not a second raw grant
    // for every file ancestor resolved while that original was still present.
    const inherited=history?[{result:{evidenceDependencies:input.conversation?.historyContext?input.conversation.evidenceDependencies:input.contextEvidenceDependencies},historyEvidenceDependencies:history.evidenceDependencies}]:[];
    const roots=historyEvidenceDependencies(store,resolveDependencies(store,receipt.evidenceDependencies),inherited,{version:1,complete:true,ids:strict});
    if(!roots?.complete)throw contextFailure('context_lineage_incomplete');
    const captured:NativeApplicationExposure={...structuredClone(receipt),evidenceDependencies:roots,originalEvidenceIds:strict,interactionId:message.id,interactionFingerprint:interactionFingerprint(message),grantScope:structuredClone(scope),...(history?{history:structuredClone(history)}:{})};
    assertExposure(captured);return captured;
  };
  const initial:NativeApplicationExposure={version:1,evidenceDependencies:{version:1,complete:(!input.conversation||input.conversation.evidenceDependencies?.complete===true)&&(input.contextEvidenceDependencies?.complete??true),ids:[...new Set([...(input.conversation?.evidenceDependencies?.ids??[]),...(input.contextEvidenceDependencies?.ids??[]),...(input.derivedContextEvidenceIds??[]),...(input.directImages?.map(image=>image.id)??[])])]},originalEvidenceIds:input.directImages?.map(image=>image.id)??[],sourceContextDependencies:[...(input.contextSourceContextDependencies??[]),...(input.conversation?.sourceContextDependencies??[])],memoryPins:(input.openingMemories??[]).map(memory=>{
    const row=store.db.prepare('SELECT json FROM memories WHERE id=?').get(memory.id);if(!row)throw contextFailure('context_evidence_restricted');const current=JSON.parse(String(row.json));return {id:memory.id,fingerprint:current.fingerprint,version:current.version};
  })};
  return {conversationId:message.conversationId,interactionId:message.id,initialExposures:[captureExposure(initial)],captureExposure,assertExposure};
}
