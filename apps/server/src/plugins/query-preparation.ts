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
import {readCurrentMemoryPage} from '../current-memory.js';
import type {MemoryRead} from '../evidence-read-ports.js';
import {parseQueuedQuery,insightSchema} from '../query-request.js';
import {hasTimeOrDeviceScope,scopedHistoryTurns,type QueryScope} from '../query-scope.js';
import type {createModelEvidenceAuthority} from '../model-evidence-authority.js';

type QueryPreparationStore=ConstructorParameters<typeof DelegationRuntime>[0];

export type SavedQuery={hostRequest:unknown;language?:QueryInput['language'];prepared?:QueryInput;configurationFingerprint?:string;historyBeforeSeq?:number};
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
  memoryReader:Pick<MemoryRead,'memoryPageAsync'>;
  configured:()=>boolean;
  authority:Pick<ReturnType<typeof createModelEvidenceAuthority>,'assert'|'contextDependencies'|'selectedQueryEvidence'|'selectedQueryMaterial'>;
  query:(input:QueryInput)=>Promise<QueryResult>;
}
/** Prepare and pin the accepted request under its current coordinator lease. */
export function createQueryPreparation(dependencies:QueryPreparationDependencies){
  const {store,files,conversations,delegation,executor,modelSettings,working,lifecycleSettings,archiveReader,memoryReader,configured,authority,query}=dependencies;
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
      // the preparation fingerprint stays for the durable generation pin, not
      // a transport fence on the durable run.
      assertModelEvidence(saved.prepared);return {...saved.prepared,signal,onProgress};
    }
    const {conversationId,question,modelProfileId,modelOverride,evidenceIds:selectedIds,anchorEvidenceIds:anchorIds,anchorMaterialRef,attachmentIds=[],...selected}=parseQueuedQuery(body);
    const previous=conversationId?conversations.get(conversationId):undefined;
    const historyBeforeSeq=previous?.turns.reduce((before,turn)=>Math.max(before,turn.seq+1),0);
    const scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone'] as const){const value=key==='timeZone'&&selected.timeZone===undefined?previous?.scope.timeZone:selected[key];if(value!==undefined&&value!==null)scope[key]=value;}
    insightSchema.parse(scope);
    if(selectedIds)scope.evidenceIds=selectedIds;
    if(anchorIds)scope.anchorEvidenceIds=anchorIds;
    if(anchorMaterialRef)scope.anchorMaterialRef=anchorMaterialRef;
    selectedQueryMaterial(scope,true);
    const bounded=hasTimeOrDeviceScope(scope);
    const scopedPrevious=previous&&(scope.evidenceIds!==undefined||bounded)?{...previous,turns:scopedHistoryTurns(previous.turns,scope,attachmentIds)}:undefined;
    const historySnapshot=previous?conversations.historyContext(scopedPrevious??previous):undefined;
    const retired=historySnapshot?conversations.retiredSelection(historySnapshot,[...(selectedIds??[]),...(anchorIds??[])]):new Set<string>();
    const historicalSelection=retired.size?{...(selectedIds?{evidenceIds:[...selectedIds]}:{}),...(anchorIds?{anchorEvidenceIds:[...anchorIds]}:{})}:undefined;
    if(scope.evidenceIds)scope.evidenceIds=scope.evidenceIds.filter(id=>!retired.has(id));
    if(scope.anchorEvidenceIds)scope.anchorEvidenceIds=scope.anchorEvidenceIds.filter(id=>!retired.has(id));
    const selectedRecords=selectedQueryEvidence({question,...scope,executionLane:'interactive'});
    const profile=modelSettings.select('chat',modelProfileId),model=modelOverride??profile.settings.model,contextTime=work.scope.contextTime!;
    if(bounded&&attachmentIds.length){
      const visible=new Set((await archiveReader.evidence({ids:attachmentIds,after:scope.after,before:scope.before,deviceId:scope.deviceId})).map(record=>record.id));
      if(attachmentIds.some(id=>!visible.has(id)))throw new StoreError('Query attachment is outside the selected scope',409);
    }
    const previousIds=scope.evidenceIds!==undefined||bounded?[]:previous?.turns.slice(-20).flatMap(turn=>turn.attachments?.map(attachment=>attachment.id)??[])??[],previousAvailable=previousIds.filter(id=>{try{return Boolean(files.detail(id).hasOriginal);}catch{return false;}});
    const directImages=queryImages([...new Set([...attachmentIds,...previousAvailable.slice(-4)])]);
    const stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const commit=<T>(write:()=>T):T=>{signal.throwIfAborted();const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');try{if(!fence||!executor.isCurrentGrant(stepId,fence))throw new StoreError('Query preparation grant expired',409);const result=write();if(own)store.db.exec('COMMIT');return result;}catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}};
    const [opening,conversation]=await Promise.all([
      openingMemoryContext({memories:async args=>{
        const page=await readCurrentMemoryPage(memoryReader,{
          kind:scope.evidenceIds!==undefined?'selection':'all',...(scope.evidenceIds!==undefined?{evidenceIds:scope.evidenceIds}:{}),
          ...(scope.after?{after:scope.after}:{}),...(scope.before?{before:scope.before}:{}),...(scope.deviceId?{deviceId:scope.deviceId}:{}),
        },{id:args.id,query:args.query,tier:args.tier,kind:args.kind,layer:args.layer,asOf:args.asOf,cursor:args.cursor,limit:args.limit,level:args.id?'detail':'overview'});
        if(!archiveReader.memories)return {...page,items:[]};
        // Retain the existing per-run disclosure policy as well as the new
        // exact-selection filter; neither an archive row nor a scope grants it.
        const visible=await Promise.all(page.items.map(item=>archiveReader.memories!({...args,id:item.id,query:undefined,cursor:undefined,limit:1})));
        return {...page,items:page.items.filter((item,index)=>visible[index].items.some(value=>Boolean(value&&typeof value==='object'&&(value as {id?:unknown}).id===item.id)))};
      }},question,{...scope,contextTime}),
      !previous?.turns.length?undefined:scopedPrevious?Promise.resolve(conversations.context(scopedPrevious,20,Math.max(1000,lifecycleSettings().contextCharacters-question.length))):working.prepare(previous,lifecycleSettings(),question,input=>query({...input,contextTime,traceContext:{...input.traceContext,operationId:work.operationId},executionLane:'interactive',modelProfileId:profile.id,modelOverride:model,signal}),{signal,commit}),
    ]);
    // Empty product selections must still answer the owner's text, but cannot
    // expose archive tools or seed the agent's nonempty extraction session.
    const emptySelection=scope.evidenceIds?.length===0&&!historicalSelection;
    const preparedScope=emptySelection?{...scope,evidenceIds:undefined}:scope;
    const prepared:QueryInput={traceContext:{operationId:work.operationId},language:saved.language??'zh-CN',executionLane:'interactive',question,...preparedScope,...(emptySelection?{hostToolSelection:[]}:{}),...(historicalSelection?{historicalSelection}:{}),...(historicalSelection?.evidenceIds&&scope.evidenceIds?.length===0?{hostRetrieval:'none' as const}:{}),...(selectedRecords.length?{processingEvidence:Object.fromEntries(selectedRecords.map(record=>[record.id,memoryEvidenceFingerprint(record)]))}:{}),contextTime,modelProfileId:profile.id,modelOverride:model,directImages,openingMemories:opening.leads,contextEvidenceDependencies:{...opening.evidenceDependencies,ids:[...new Set([...opening.evidenceDependencies.ids,...(scope.evidenceIds??[]),...(scope.anchorEvidenceIds??[])])]},...(conversation?{conversation}:{})};
    commit(()=>{
      assertModelEvidence(prepared);
      const freshImages=queryImages(directImages.map(image=>image.id));
      if(freshImages.some((image,index)=>image.hash!==directImages[index].hash||image.mimeType!==directImages[index].mimeType||image.sizeBytes!==directImages[index].sizeBytes))throw new StoreError('Query attachment changed during preparation',409);
      for(const image of directImages){const version=files.version(image.id);if(!store.evidence([image.id]).length||!fileAttachmentAvailable(store,image.id)||store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(version.source_id,version.external_id)?.deleted)throw new StoreError('Query attachment is no longer available',409);}
      delegation.recordEvidence(work.id,[...(contextDependencies(prepared)?.ids??[]),...directImages.map(image=>image.id)]);
      delegation.journal.savePayload(work.id,{...saved,prepared,...(historyBeforeSeq===undefined?{}:{historyBeforeSeq}),configurationFingerprint:modelConfiguration(profile.id,{...profile.settings,model},modelSettings.view().revision).fingerprint});
    });
    return {...prepared,signal,onProgress};
  }
  return {prepare};
}
