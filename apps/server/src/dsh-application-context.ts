import {createHash} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {NativeApplicationContext,NativeApplicationExposure} from '@mote/agent/runtime/dsh';
import type {Conversations} from './conversations.js';
import type {Store} from './store.js';
import {contextFailure} from './model-evidence-authority.js';
import {resolveDependencies} from './conversation-lineage.js';
import type {QueryScope} from './query-scope.js';

const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A durable accepted user message, including failed/cancelled runs. Status and
 * the eventual result are mutable; its actual input and membership are not. */
const interactionFingerprint=(message:ReturnType<Conversations['message']>)=>fingerprint([message.question,message.scope,message.attachments??[],message.modelProfileId??null,message.modelOverride??null]);

/** This hook is constructed only on the ordinary admitted query path. It uses
 * the current generic model/evidence policy, not old native permissions. */
export function nativeApplicationContext(input:QueryInput,dependencies:{store:Store;conversations:Pick<Conversations,'message'|'messageForRun'|'assertHistoryContext'>;assertModelEvidence:(input:QueryInput)=>void}):NativeApplicationContext|undefined {
  const operation=input.traceContext?.operationId;
  if(input.executionLane!=='interactive'||!operation?.startsWith('query:')||input.responseMode&&input.responseMode!=='answer')return;
  const {store,conversations,assertModelEvidence}=dependencies,message=conversations.messageForRun(operation.slice(6));
  if(!message||message.question!==input.question)return;
  const scope:QueryScope={};
  for(const key of ['sourceIds','after','before','deviceId','timeZone'] as const)if((input as QueryInput&QueryScope)[key]!==undefined)Object.assign(scope,{[key]:(input as QueryInput&QueryScope)[key]});
  const assertExposure=(receipt:NativeApplicationExposure)=>{
    input.signal?.throwIfAborted();
    if(receipt.version!==1||receipt.evidenceDependencies.version!==1||!receipt.evidenceDependencies.complete)throw contextFailure('context_lineage_incomplete');
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
    if(receipt.originalEvidenceIds.length)assertModelEvidence({question:'',...scope,contextEvidenceDependencies:{version:1,complete:true,ids:[...receipt.originalEvidenceIds]}});
  };
  const captureExposure=(receipt:NativeApplicationExposure):NativeApplicationExposure=>{
    const history=input.conversation?.historyContext??input.historyContext;
    const captured:NativeApplicationExposure={...structuredClone(receipt),evidenceDependencies:resolveDependencies(store,receipt.evidenceDependencies)!,interactionId:message.id,interactionFingerprint:interactionFingerprint(message),...(history?{history:structuredClone(history)}:{})};
    assertExposure(captured);return captured;
  };
  const initial:NativeApplicationExposure={version:1,evidenceDependencies:{version:1,complete:(!input.conversation||input.conversation.evidenceDependencies?.complete===true)&&(input.contextEvidenceDependencies?.complete??true),ids:[...new Set([...(input.conversation?.evidenceDependencies?.ids??[]),...(input.contextEvidenceDependencies?.ids??[]),...(input.derivedContextEvidenceIds??[]),...(input.directImages?.map(image=>image.id)??[])])]},originalEvidenceIds:input.directImages?.map(image=>image.id)??[],sourceContextDependencies:[...(input.contextSourceContextDependencies??[]),...(input.conversation?.sourceContextDependencies??[])],memoryPins:(input.openingMemories??[]).map(memory=>{
    const row=store.db.prepare('SELECT json FROM memories WHERE id=?').get(memory.id);if(!row)throw contextFailure('context_evidence_restricted');const current=JSON.parse(String(row.json));return {id:memory.id,fingerprint:current.fingerprint,version:current.version};
  })};
  return {conversationId:message.conversationId,interactionId:message.id,initialExposures:[captureExposure(initial)],captureExposure,assertExposure};
}
