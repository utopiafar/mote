import {agentModelConnection} from './model-authorization-host.js';
import {isDeepStrictEqual} from 'node:util';
import {conversationMessageSchema,type ConversationMessageInput} from '@mote/shared';
import {scopeRecord} from './evidence-scope-record.js';
import {withinEvidenceScope} from './evidence-reader.js';
import {EvidenceExposurePolicy} from './evidence-exposure.js';
import {resolveDependencies} from './conversation-lineage.js';
import {safeError} from './diagnostics.js';
import {StoreError} from './store.js';
import type {ConversationMessage} from './conversations.js';
import type {QueryRunDependencies} from './plugins/query-runs.js';
import type {DelegatedQueryRuns} from './delegated-query-runs.js';

/** Convert a persisted product scope to the existing query input. An explicit
 * empty intersection stays empty, and no source list becomes a bulk prompt. */
export function conversationQueryInput(dependencies:QueryRunDependencies,message:ConversationMessage){
  const {store,evidenceReader}=dependencies,{kind,sourceIds,anchorEvidenceIds,anchorMaterialRef,evidenceIds,...range}=message.scope;
  let ids=evidenceIds&&[...new Set(evidenceIds)];
  if(kind==='selection'&&sourceIds!==undefined){
    const sources=new Set(dependencies.modelEvidenceAuthority.selectedQuerySources(sourceIds)),policy=new EvidenceExposurePolicy([],context=>sources.has(context.sourceId??''));
    if(ids)ids=ids.filter(id=>{
      const record=scopeRecord(store,id),lineage=resolveDependencies(store,{version:1,complete:true,ids:[id]});
      return Boolean((!record||withinEvidenceScope(record,range))&&lineage&&evidenceReader.contextDependenciesAllowed(lineage.ids,policy));
    });
    else if(!sourceIds.length)ids=[];
  }
  if(ids&&ids.length>30)throw new StoreError('Selected evidence exceeds the current 30-original query limit',413);
  if(anchorEvidenceIds&&ids!==undefined&&anchorEvidenceIds.some(id=>!ids!.includes(id)))throw new StoreError('Reference is outside the selected scope',409);
  if(message.attachments?.some(item=>ids!==undefined&&!ids.includes(item.id)))throw new StoreError('Attachment is outside the selected scope',409);
  return {conversationId:message.conversationId,question:message.question,...range,
    ...(kind==='selection'&&sourceIds!==undefined?{sourceIds:[...new Set(sourceIds)]}:{}),
    ...(message.modelProfileId?{modelProfileId:message.modelProfileId}:{}),...(message.modelOverride?{modelOverride:message.modelOverride}:{}),
    evidenceIds:ids??null,anchorEvidenceIds:anchorEvidenceIds??null,anchorMaterialRef:anchorMaterialRef??null,
    ...(message.attachments?.length?{attachmentIds:message.attachments.map(item=>item.id)}:{})};
}

/** Product ordering only. Execution, durable work and model slots remain owned
 * by the existing query runner. The turn itself is the durable queue entry. */
export class ConversationQueue {
  private active=new Set<string>();
  private suspended=new Set<string>();
  private scheduled=false;
  private closed=true;
  constructor(private readonly dependencies:QueryRunDependencies,private readonly runs:DelegatedQueryRuns){}

  start(){this.closed=false;this.wake();}
  close(){this.closed=true;}
  wake(){
    if(this.closed||this.scheduled)return;
    this.scheduled=true;
    queueMicrotask(()=>{
      this.scheduled=false;if(this.closed)return;
      for(const message of this.dependencies.conversations.pendingHeads()){
        if(this.active.has(message.conversationId)||this.suspended.has(message.id))continue;
        this.active.add(message.conversationId);
        void this.run(message).finally(()=>{this.active.delete(message.conversationId);this.wake();});
      }
    });
  }

  private transaction<T>(write:()=>T):T{
    const db=this.dependencies.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{const value=write();if(own)db.exec('COMMIT');return value;}
    catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  admit(input:ConversationMessageInput){
    const {store,files,conversations,modelAuthorizationHost,modelSettings,evidenceReader}=this.dependencies;
    const prior=conversations.messageByClientRequestId(input.clientRequestId);
    if(prior){
      const {anchorEvidenceIds,anchorMaterialRef,...priorScope}=prior.scope;
      if(prior.conversationId!==input.conversationId||prior.question!==input.question||prior.modelProfileId!==input.modelProfileId||prior.modelOverride!==input.modelOverride||!isDeepStrictEqual(priorScope,input.scope)||!isDeepStrictEqual(anchorEvidenceIds,input.anchorEvidenceIds)||anchorMaterialRef!==input.anchorMaterialRef||!isDeepStrictEqual(prior.attachments?.map(item=>item.id)??[],input.attachmentIds??[]))throw new StoreError('clientRequestId belongs to a different message',409);
      this.suspended.clear();this.wake();return this.view(prior);
    }
    if(this.closed)throw new StoreError('Conversation query admission is unavailable',503);
    const scope={...input.scope,...(input.anchorEvidenceIds?{anchorEvidenceIds:input.anchorEvidenceIds}:{}),...(input.anchorMaterialRef?{anchorMaterialRef:input.anchorMaterialRef}:{})};
    if(input.anchorMaterialRef&&(input.scope.kind==='selection'||input.scope.evidenceIds!==undefined))throw new StoreError('A material reference cannot yet be combined with a restricted selection',400);
    const attachments=(input.attachmentIds??[]).map(id=>{
      const record=scopeRecord(store,id);
      if(!record||!evidenceReader.contextDependenciesAllowed([id])||!withinEvidenceScope(record,input.scope)||input.scope.evidenceIds!==undefined&&!input.scope.evidenceIds.includes(id)||input.scope.kind==='selection'&&input.scope.sourceIds!==undefined&&!input.scope.sourceIds.includes(record.provenance?.sourceId??''))throw new StoreError('Attachment is outside the selected scope',409);
      files.detail(id);
      // The user's immutable input contains the ID, not a cached filename or
      // MIME description that could survive withdrawal of the original.
      return {id,name:'',mimeType:''};
    });
    const profile=modelSettings.select('chat',input.modelProfileId),connections=[...this.dependencies.availableModelConnections(),agentModelConnection({kind:'profile',id:profile.id},{...profile.settings,model:input.modelOverride??profile.settings.model})];
    const message=this.transaction(()=>{
      let saved=conversations.receive({conversationId:input.conversationId,clientRequestId:input.clientRequestId,question:input.question,...scope,...(input.modelProfileId?{modelProfileId:input.modelProfileId}:{}),...(input.modelOverride?{modelOverride:input.modelOverride}:{}),...(attachments.length?{attachments}:{})});
      // This owner command and its manual model authority commit together. A
      // restart can resume it without inventing automatic permission.
      modelAuthorizationHost.control.manual('owner-query:'+saved.id,'manual',[],connections);
      if(saved.status==='accepted'&&store.db.prepare("SELECT 1 FROM conversation_turns WHERE conversation_id=? AND idx<? AND json_extract(json,'$.status') IN ('accepted','queued','running') LIMIT 1").get(saved.conversationId,saved.seq))saved=conversations.queue(saved.id,{expectedVersion:saved.version});
      return saved;
    });
    this.suspended.clear();this.wake();return this.view(message);
  }

  view(message:ConversationMessage){
    const {anchorEvidenceIds,anchorMaterialRef,kind,sourceIds,...filters}=message.scope;
    const attachmentIds=message.attachments?.filter(item=>this.dependencies.evidenceReader.contextDependenciesAllowed([item.id])).map(item=>item.id);
    return conversationMessageSchema.parse({id:message.id,conversationId:message.conversationId,clientRequestId:message.clientRequestId,question:message.question,
      scope:{kind:kind??'all',...filters,...(kind==='selection'&&sourceIds!==undefined?{sourceIds}:{})},revision:message.version,status:message.status,seq:message.seq,createdAt:message.createdAt,
      ...(anchorEvidenceIds?{anchorEvidenceIds}:{}),...(anchorMaterialRef?{anchorMaterialRef}:{}),...(attachmentIds?.length?{attachmentIds}:{}),
      ...(message.modelProfileId?{modelProfileId:message.modelProfileId}:{}),...(message.modelOverride?{modelOverride:message.modelOverride}:{}),
      ...(message.runId?{runId:message.runId}:{}),...(message.evidenceDeleted?{evidenceDeleted:true}:{}),...(message.evidenceStale?{evidenceStale:true}:{}),...(message.evidenceUnavailable?{evidenceUnavailable:true}:{}),...(message.historyEvidenceDependencies?{historyEvidenceDependencies:message.historyEvidenceDependencies}:{})});
  }
  get(conversationId:string,id:string){const message=this.dependencies.conversations.message(id);if(message.conversationId!==conversationId)throw new StoreError('Conversation message not found',404);return this.view(message);}
  cancel(conversationId:string,id:string){
    const message=this.dependencies.conversations.message(id);if(message.conversationId!==conversationId)throw new StoreError('Conversation message not found',404);
    const cancelled=this.dependencies.conversations.cancel(id);
    if(cancelled.runId&&this.dependencies.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(cancelled.runId))this.runs.cancel(cancelled.runId);
    this.suspended.clear();this.wake();return this.view(cancelled);
  }

  private async run(initial:ConversationMessage){
    const {conversations,store,modelAuthorizationHost}=this.dependencies;
    try{
      let message=conversations.message(initial.id);
      if(!['accepted','queued','running'].includes(message.status))return;
      if(!message.runId)message=conversations.attachRun(message.id,message.id,{expectedVersion:message.version});
      if(message.status==='queued')message=conversations.running(message.id,{expectedVersion:message.version});
      const id=message.runId!;
      if(!store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(id)){
        const input=conversationQueryInput(this.dependencies,message);
        await modelAuthorizationHost.control.run('owner-query:'+id,async()=>{if(this.closed)return;this.runs.start(id,input);});
        if(this.closed)return;
      }
      const settled=await this.runs.waitForSettlement(id);if(this.closed)return;
      const current=conversations.message(message.id);
      if(!['accepted','queued','running'].includes(current.status))return;
      if(settled.status==='cancelled')conversations.cancel(current.id);
      else if(settled.status==='failed')conversations.fail(current.id,{code:settled.error?.code??'query_failed',message:settled.error?.message??'Query did not complete'},{expectedVersion:current.version});
    }catch(error){
      if(this.closed)return;
      // The server interrupts query waiters before plugin disposal. Preserve
      // the accepted turn so the next activation can resume its durable run.
      if(error instanceof StoreError&&error.statusCode===503&&modelAuthorizationHost.control.workState('owner-query:'+(initial.runId??initial.id))!=='missing'){this.closed=true;return;}
      try{
        const current=conversations.message(initial.id);
        if(!['accepted','queued','running'].includes(current.status))return;
        const other=store.db.prepare("SELECT id FROM query_runs WHERE id<>? AND json_extract(json,'$.conversationId')=? AND json_extract(json,'$.status')='running' LIMIT 1").get(current.runId??'',current.conversationId);
        if(other){await this.runs.waitForSettlement(String(other.id));return;}
        const failure=safeError(error);conversations.fail(current.id,{code:failure.category,message:failure.message},{expectedVersion:current.version});
      }catch{
        // A failed terminal write (for example a full vault) must not create
        // an unbounded microtask loop. Preserve the turn for a later wake or
        // restart; deletion and shutdown likewise need no product write.
        this.suspended.add(initial.id);
      }
    }
  }
}
