import type {QueryInput} from '@mote/agent';
import {ProviderFailure,type CaptureRecord,type EvidenceDependencies} from '@mote/shared';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import type {EvidenceReader,MemoryCatalogMetadataReceipt} from './evidence-reader.js';
import type {Conversations} from './conversations.js';
import type {BackgroundModelAuthorization} from './background-model-authorization.js';
import type {ModelAuthorizationHost} from './model-authorization-host.js';
import type {SourceContextStore} from './source-context.js';
import {assertSourceContextDependencies,combineSourceContextDependencies} from './source-context-lineage.js';
import {combineDependencies} from './conversation-lineage.js';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import {memoryEvidenceFingerprint} from './memory.js';
import type {assertMemoryImageGrants} from './memory-image-grants.js';
import {StoreError} from './store.js';

export const contextFailure=(code:'context_lineage_incomplete'|'context_evidence_restricted')=>Object.assign(new StoreError(code,409),{code});
export interface ModelEvidenceAuthorityDependencies {
  resolveLineage:(value:EvidenceDependencies|undefined)=>EvidenceDependencies|undefined;
  assertImageGrants:(materials:Parameters<typeof assertMemoryImageGrants>[1],images:Parameters<typeof assertMemoryImageGrants>[2])=>void;
  reader:Pick<EvidenceReader,'deletionContextAllowed'|'contextDependenciesAllowed'|'currentMemoryLeadsAllowed'|'evidence'|'memoryCatalogMetadataAllowed'|'processingEvidenceAllowed'|'memoryCatalogMetadata'|'queryMaterialReference'>;
  conversations:Pick<Conversations,'assertHistoryContext'|'retiredSelection'>;
  sourceContexts:SourceContextStore;
  authorization:Pick<BackgroundModelAuthorization,'currentId'|'assertDisclosure'>;
  host:Pick<ModelAuthorizationHost,'assertEvidence'>;
  readEvidence:(ids:string[])=>CaptureRecord[];
}
/** One authority fence shared by preparation, outbound model requests and publication. */
export function createModelEvidenceAuthority(dependencies:ModelEvidenceAuthorityDependencies){
  const {resolveLineage,assertImageGrants,reader:evidenceReader,conversations,sourceContexts,authorization:modelAuthorization,host:modelAuthorizationHost,readEvidence}=dependencies;
  const contextDependencies=(input:QueryInput|undefined)=>resolveLineage(combineDependencies([
    ...(input?.conversation?[input.conversation.evidenceDependencies??{version:1 as const,complete:false,ids:[]}]:[]),
    ...(input?.contextEvidenceDependencies?[input.contextEvidenceDependencies]:[]),
    ...(input?.derivedContextEvidenceIds?[{version:1 as const,complete:true,ids:[...input.derivedContextEvidenceIds]}]:[]),
  ]));
  const sourceContextDependencies=(input:QueryInput|undefined)=>combineSourceContextDependencies([input?.conversation?.sourceContextDependencies,input?.contextSourceContextDependencies]);
  const modelContextGroups=(input:QueryInput|undefined)=>{
    const historicalIds=new Set(input?.conversation?.historyContext?input.conversation.evidenceDependencies?.ids:[]);
    return [
    ...(input?.conversation?[{ids:(input.conversation.historyContext?.evidenceDependencies??input.conversation.evidenceDependencies)?.ids??[],historical:Boolean(input.conversation.historyContext),snapshot:input.conversation.historyContext}]:[]),
    ...(input?.contextEvidenceDependencies?[{ids:input.historyContext?input.historyContext.evidenceDependencies.ids:input.contextEvidenceDependencies.ids.filter(id=>!historicalIds.has(id)),historical:Boolean(input.historyContext),snapshot:input.historyContext}]:[]),
    ...(input?.derivedContextEvidenceIds?[{ids:input.derivedContextEvidenceIds,historical:false,snapshot:undefined}]:[]),
    ].map(group=>({...group,ids:resolveLineage({version:1,complete:true,ids:[...group.ids]})!.ids}));
  };
  const assertModelContext=(input:QueryInput|undefined)=>{
    for(const snapshot of [input?.historyContext,input?.conversation?.historyContext])if(snapshot){conversations.assertHistoryContext(snapshot);if(!snapshot.evidenceDependencies.complete)throw contextFailure('context_lineage_incomplete');}
    if(input?.historicalSelection){
      const snapshot=input.conversation?.historyContext;if(!snapshot)throw contextFailure('context_lineage_incomplete');
      const removed=[...(input.historicalSelection.evidenceIds??[]).filter(id=>!input.evidenceIds?.includes(id)),...(input.historicalSelection.anchorEvidenceIds??[]).filter(id=>!input.anchorEvidenceIds?.includes(id))];
      const permitted=conversations.retiredSelection(snapshot,removed);
      if(removed.some(id=>!permitted.has(id))||input.historicalSelection.evidenceIds&&input.evidenceIds===undefined)throw contextFailure('context_evidence_restricted');
    }
    assertSourceContextDependencies(sourceContexts,sourceContextDependencies(input));
    if(input?.derivedContextEvidenceIds?.some(id=>!evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy())))throw new StoreError('Derived context evidence is no longer permitted for this model',409);
    const conversationText=Boolean(input?.conversation?.workingMemory?.text||input?.conversation?.turns.some(turn=>!turn.evidenceDeleted&&turn.answer));
    const taskText=Boolean(input?.taskContext?.previousSummary||input?.taskContext?.turns?.length);
    if((conversationText&&input?.conversation?.evidenceDependencies?.complete!==true)||((taskText||input?.openingMemories?.length)&&input?.contextEvidenceDependencies?.complete!==true)||input?.openingMemories?.length&&!input?.contextEvidenceDependencies?.ids.length)throw contextFailure('context_lineage_incomplete');
    if(input?.openingMemories?.length&&!evidenceReader.currentMemoryLeadsAllowed(input.openingMemories,input.contextTime))throw contextFailure('context_evidence_restricted');
  };
  // Exact public selections use the normal current-original exposure policy and
  // retain a content pin across preparation, outbound calls and publication.
  const selectedQueryEvidence=(input:QueryInput)=>{
    const ids=input.evidenceIds??input.anchorEvidenceIds;
    if(input.executionLane!=='interactive'||ids===undefined||input.responseMode==='memory-extraction')return [];
    if(!evidenceReader.contextDependenciesAllowed(ids,new EvidenceExposurePolicy()))throw contextFailure('context_evidence_restricted');
    const records=evidenceReader.evidence(ids.map(id=>'capture:'+id),input);
    if(records.length!==ids.length||input.processingEvidence&&records.some(record=>input.processingEvidence![record.id]!==memoryEvidenceFingerprint(record)))throw contextFailure('context_evidence_restricted');
    return records;
  };
  const selectedQueryMaterial=(input:Pick<QueryInput,'anchorMaterialRef'|'after'|'before'|'deviceId'>,scoped=false)=>{
    // Admission/preparation check the whole selected range. A delegated child
    // can narrow that range; its actual reads still enforce the narrower scope,
    // while every model boundary keeps checking the selected version/exposure.
    if(input.anchorMaterialRef&&!evidenceReader.queryMaterialReference(input.anchorMaterialRef,scoped?input:{}))throw contextFailure('context_evidence_restricted');
  };
  const assertModelEvidence=(input:QueryInput|undefined)=>{
    if(input)selectedQueryMaterial(input);
    if(modelAuthorization.currentId){
      modelAuthorizationHost.assertEvidence([...(input?.evidenceIds??[]),...modelContextGroups(input).flatMap(group=>group.ids)]);
      modelAuthorization.assertDisclosure(sourceContextDependencies(input).map(pin=>({sourceId:pin.sourceId})));
      const catalog=(input as QueryInput&{memoryCatalogMetadata?:MemoryCatalogMetadataReceipt}|undefined)?.memoryCatalogMetadata;
      if(catalog)modelAuthorization.assertDisclosure(catalog.members.flatMap(member=>member.sourceId?[{sourceId:member.sourceId}]:[]));
      if((input?.taskContext as {turns?:unknown[]}|undefined)?.turns?.length)modelAuthorization.assertDisclosure([{sourceId:'mote.conversations'}]);
    }
    if(input)selectedQueryEvidence(input);
    input?.assertContextAuthority?.();
    const catalog=(input as (QueryInput&{memoryCatalogMetadata?:MemoryCatalogMetadataReceipt})|undefined)?.memoryCatalogMetadata;
    if(catalog&&!evidenceReader.memoryCatalogMetadataAllowed(catalog,new EvidenceExposurePolicy()))throw Object.assign(new ProviderFailure({category:'permanent',code:'context_evidence_restricted'}),{statusCode:409,code:'context_evidence_restricted'});
    assertModelContext(input);
    if(input?.processingImages?.length){
      assertImageGrants(input.processingMaterialInputs??[],input.processingImages);
      if(!evidenceReader.processingEvidenceAllowed(input.processingImages.map(image=>image.id),input.processingEvidence,input.processingMaterialInputs,new EvidenceExposurePolicy()))throw contextFailure('context_evidence_restricted');
    }
    // Derived nodes remain in the fence alongside every original ancestor.
    // Private metadata checks never disclose bodies or grant raw reads.
    for(const group of modelContextGroups(input))if(!evidenceReader.contextDependenciesAllowed(group.ids,new EvidenceExposurePolicy(),group.historical,group.snapshot?conversations.assertHistoryContext(group.snapshot):undefined))throw contextFailure('context_evidence_restricted');
    // The bridge may already hold restricted originals while deletion or a
    // Formal input/owner declaration changes. Check the frozen Memory grant at
    // every outbound request as well as before entering the agent; publication
    // validation alone cannot recall a seed already sent to the provider.
    if(input?.responseMode==='memory-extraction'&&input.evidenceIds!==undefined&&!evidenceReader.processingEvidenceAllowed(
      [...input.evidenceIds,...((input as QueryInput&{processingDisclosedEvidenceIds?:string[]}).processingDisclosedEvidenceIds??[])],input.processingEvidence,input.processingMaterialInputs,new EvidenceExposurePolicy(),
    ))throw Object.assign(new ProviderFailure({category:'permanent',code:'context_evidence_restricted'}),{statusCode:409,code:'context_evidence_restricted'});
  };
  const assertModelEvidenceAsync=async(input:QueryInput)=>{
    selectedQueryMaterial(input);
    selectedQueryEvidence(input);
    input.assertContextAuthority?.();
    assertModelContext(input);
    const policy=new EvidenceExposurePolicy();
    // This is scheduling granularity, not a scope or processing limit. Inspect
    // every dependency while allowing lease renewal, cancellation and intake.
    for(const group of modelContextGroups(input))for(let offset=0;offset<group.ids.length;offset+=256){
      input.signal?.throwIfAborted();
      if(!evidenceReader.contextDependenciesAllowed(group.ids.slice(offset,offset+256),policy,group.historical,group.snapshot?conversations.assertHistoryContext(group.snapshot):undefined))throw contextFailure('context_evidence_restricted');
      await yieldEventLoop();
    }
    input.signal?.throwIfAborted();
  };
  const pinProcessingEvidence=(input:QueryInput):QueryInput=>{
    const supplied=input as QueryInput&{memoryCatalogMetadata?:MemoryCatalogMetadataReceipt};
    if(!supplied.memoryCatalogMetadata){const receipt=evidenceReader.memoryCatalogMetadata(input.taskContext);if(receipt)input={...input,memoryCatalogMetadata:receipt,contextSourceContextDependencies:combineSourceContextDependencies([input.contextSourceContextDependencies,receipt.sourceContextDependencies])} as QueryInput;}
    if(!input.evidenceIds||input.executionLane==='interactive')return input;
    const missing=input.evidenceIds.filter(id=>!input.processingEvidence?.[id]);
    return missing.length?{...input,processingEvidence:{...Object.fromEntries(readEvidence(missing).map(record=>[record.id,memoryEvidenceFingerprint(record)])),...input.processingEvidence}}:input;
  };
  return {contextDependencies,sourceContextDependencies,selectedQueryEvidence,selectedQueryMaterial,pinProcessingEvidence,assert:assertModelEvidence,assertAsync:assertModelEvidenceAsync};
}
