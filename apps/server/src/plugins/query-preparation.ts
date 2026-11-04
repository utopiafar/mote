import {AgentNotConfiguredError,type ContextReader,type QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {StoreError} from '../store.js';
import type {FileStore} from '../files.js';
import {fileAttachmentAvailable} from '../file-attachments.js';
import type {Conversations} from '../conversations.js';
import type {DelegationRuntime,DelegationWork} from '../delegation-runtime.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {WorkingMemory} from '../working-memory.js';
import type {LifecycleSettings} from '../memory-lifecycle.js';
import type {ModelSettingsStore} from '../model-settings.js';
import {modelConfiguration} from '../model-configuration.js';
import {memoryEvidenceFingerprint} from '../memory.js';
import {openingMemoryContext} from '../opening-memory.js';
import {queryWithAttachmentsSchema,insightSchema} from '../query-request.js';
import type {QueryScope} from '../query-scope.js';
import type {QueryQualityStage,QueryQualityStrategy} from '../query-quality-experiment.js';
import type {createModelEvidenceAuthority} from '../model-evidence-authority.js';

type QueryPreparationStore=ConstructorParameters<typeof DelegationRuntime>[0];

export type SavedQuery={hostRequest:unknown;language?:QueryInput['language'];prepared?:QueryInput;configurationFingerprint?:string;qualityStrategy?:QueryQualityStrategy;qualityStages?:Partial<Record<QueryQualityStage,QueryResult>>};
export interface QueryPreparationDependencies {
  store:QueryPreparationStore;
  files:Pick<FileStore,'detail'|'version'>;
  conversations:Pick<Conversations,'get'|'context'|'historyContext'|'retiredSelection'>;
  delegation:Pick<DelegationRuntime,'journal'|'recordEvidence'>;
  executor:Pick<ExecutionEngine,'isCurrentGrant'>;
  modelSettings:Pick<ModelSettingsStore,'select'|'view'>;
  working:Pick<WorkingMemory,'prepare'>;
  lifecycleSettings:()=>LifecycleSettings;
  archiveReader:ContextReader;
  configured:()=>boolean;
  authority:Pick<ReturnType<typeof createModelEvidenceAuthority>,'assert'|'contextDependencies'|'selectedQueryEvidence'|'selectedQueryMaterial'>;
  query:(input:QueryInput)=>Promise<QueryResult>;
  qualityStrategy?:QueryQualityStrategy;
}
/** Prepare and pin the accepted request under its current coordinator lease. */
export function createQueryPreparation(dependencies:QueryPreparationDependencies){
  const {store,files,conversations,delegation,executor,modelSettings,working,lifecycleSettings,archiveReader,configured,authority,query,qualityStrategy}=dependencies;
  const {assert:assertModelEvidence,contextDependencies,selectedQueryEvidence,selectedQueryMaterial}=authority;
  const queryImages=(ids:string[])=>ids.map(id=>{
    const detail=files.detail(id),version=files.version(id),mimeType=detail.item.mimeType;
    if(!detail.hasOriginal||!version.object_hash||!['image/png','image/jpeg','image/webp'].includes(mimeType??'')||detail.sizeBytes<1||detail.sizeBytes>8*1024*1024)throw new StoreError('Query attachment must be an archived image up to 8 MiB',400);
    return {id,name:detail.item.title||'Attached image',mimeType:mimeType!,hash:version.object_hash,sizeBytes:detail.sizeBytes};
  });
  async function prepare(body:unknown,work:DelegationWork,signal:AbortSignal,onProgress:QueryInput['onProgress']):Promise<QueryInput>{
    signal.throwIfAborted();if(!configured())throw new AgentNotConfiguredError();
    const saved=delegation.journal.payload<SavedQuery>(work.id);
    if(saved.prepared){
      // An accepted run keeps the model identity pinned by its first
      // preparation. An ordinary model-settings switch affects only new runs;
      // the preparation fingerprint stays for the explicit quality-experiment
      // checkpoint, not a transport fence on the durable run.
      assertModelEvidence(saved.prepared);return {...saved.prepared,signal,onProgress};
    }
    const {conversationId,question,modelProfileId,modelOverride,evidenceIds:selectedIds,anchorEvidenceIds:anchorIds,anchorMaterialRef,attachmentIds=[],...selected}=queryWithAttachmentsSchema.parse(body);
    const previous=conversationId?conversations.get(conversationId):undefined;
    if(previous&&previous.turnCount>=200)throw new StoreError('Conversation has reached its turn limit; start a new conversation',409);
    const scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone'] as const){const value=key==='timeZone'&&selected.timeZone===undefined?previous?.scope.timeZone:selected[key];if(value!==undefined&&value!==null)scope[key]=value;}
    insightSchema.parse(scope);
    if(selectedIds)scope.evidenceIds=selectedIds;
    if(anchorIds)scope.anchorEvidenceIds=anchorIds;
    if(anchorMaterialRef)scope.anchorMaterialRef=anchorMaterialRef;
    selectedQueryMaterial(scope,true);
    const allowedHistoryIds=new Set([...(scope.evidenceIds??[]),...attachmentIds]);
    const selectedScope=JSON.stringify([...(scope.evidenceIds??[])].sort());
    const scopedPrevious=previous&&scope.evidenceIds?{...previous,turns:previous.turns.filter(turn=>
      JSON.stringify([...(turn.scope.evidenceIds??[])].sort())===selectedScope&&
      (turn.attachments??[]).every(attachment=>allowedHistoryIds.has(attachment.id))&&
      turn.result?.evidenceDependencies?.complete===true&&turn.result.evidenceDependencies.ids.every(id=>allowedHistoryIds.has(id))&&
      turn.historyEvidenceDependencies?.complete===true&&turn.historyEvidenceDependencies.ids.every(id=>allowedHistoryIds.has(id))
    )}:undefined;
    const historySnapshot=previous?conversations.historyContext(scopedPrevious??previous):undefined;
    const retired=historySnapshot?conversations.retiredSelection(historySnapshot,[...(selectedIds??[]),...(anchorIds??[])]):new Set<string>();
    const historicalSelection=retired.size?{...(selectedIds?{evidenceIds:[...selectedIds]}:{}),...(anchorIds?{anchorEvidenceIds:[...anchorIds]}:{})}:undefined;
    if(scope.evidenceIds)scope.evidenceIds=scope.evidenceIds.filter(id=>!retired.has(id));
    if(scope.anchorEvidenceIds)scope.anchorEvidenceIds=scope.anchorEvidenceIds.filter(id=>!retired.has(id));
    const selectedRecords=selectedQueryEvidence({question,...scope,executionLane:'interactive'});
    const profile=modelSettings.select('chat',modelProfileId),model=modelOverride??profile.settings.model,contextTime=work.scope.contextTime!;
    const previousIds=scope.evidenceIds?[]:previous?.turns.slice(-20).flatMap(turn=>turn.attachments?.map(attachment=>attachment.id)??[])??[],previousAvailable=previousIds.filter(id=>{try{return Boolean(files.detail(id).hasOriginal);}catch{return false;}});
    const directImages=queryImages([...new Set([...attachmentIds,...previousAvailable.slice(-4)])]);
    const stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const commit=<T>(write:()=>T):T=>{signal.throwIfAborted();const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');try{if(!fence||!executor.isCurrentGrant(stepId,fence))throw new StoreError('Query preparation grant expired',409);const result=write();if(own)store.db.exec('COMMIT');return result;}catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}};
    const [opening,conversation]=await Promise.all([
      scope.evidenceIds?Promise.resolve({leads:[],evidenceDependencies:{version:1 as const,complete:true,ids:scope.evidenceIds}}):openingMemoryContext(archiveReader,question,{...scope,contextTime}),
      scopedPrevious?Promise.resolve(conversations.context(scopedPrevious,20,Math.max(1000,lifecycleSettings().contextCharacters-question.length))):previous?working.prepare(previous,lifecycleSettings(),question,input=>query({...input,contextTime,traceContext:{...input.traceContext,operationId:work.operationId},executionLane:'interactive',modelProfileId:profile.id,modelOverride:model,signal}),{signal,commit}):undefined,
    ]);
    const prepared:QueryInput={traceContext:{operationId:work.operationId},language:saved.language??'zh-CN',executionLane:'interactive',question,...scope,...(historicalSelection?{historicalSelection}:{}),...(historicalSelection?.evidenceIds&&scope.evidenceIds?.length===0?{hostRetrieval:'none' as const}:{}),...(selectedRecords.length?{processingEvidence:Object.fromEntries(selectedRecords.map(record=>[record.id,memoryEvidenceFingerprint(record)]))}:{}),contextTime,modelProfileId:profile.id,modelOverride:model,directImages,openingMemories:opening.leads,contextEvidenceDependencies:{...opening.evidenceDependencies,ids:[...new Set([...opening.evidenceDependencies.ids,...(scope.anchorEvidenceIds??[])])]},...(conversation?{conversation}:{})};
    commit(()=>{
      assertModelEvidence(prepared);
      const freshImages=queryImages(directImages.map(image=>image.id));
      if(freshImages.some((image,index)=>image.hash!==directImages[index].hash||image.mimeType!==directImages[index].mimeType||image.sizeBytes!==directImages[index].sizeBytes))throw new StoreError('Query attachment changed during preparation',409);
      for(const image of directImages){const version=files.version(image.id);if(!store.evidence([image.id]).length||!fileAttachmentAvailable(store,image.id)||store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(version.source_id,version.external_id)?.deleted)throw new StoreError('Query attachment is no longer available',409);}
      delegation.recordEvidence(work.id,[...(contextDependencies(prepared)?.ids??[]),...directImages.map(image=>image.id)]);
      delegation.journal.savePayload(work.id,{...saved,prepared,configurationFingerprint:modelConfiguration(profile.id,{...profile.settings,model},modelSettings.view().revision).fingerprint,...(qualityStrategy?{qualityStrategy}:{})});
    });
    return {...prepared,signal,onProgress};
  }
  return {prepare};
}
