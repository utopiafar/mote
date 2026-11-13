import {inheritRetiredConversationRoots,unavailableHistoryEvidence} from './conversation-retention.js';
import {createHash,randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store,StoreError} from './store.js';
import {combineDependencies,resolveDependencies,historyEvidenceDependencies} from './conversation-lineage.js';
import {SourceContextStore} from './source-context.js';
import {assertSourceContextDependencies,combineSourceContextDependencies,sourceContextDependenciesCurrent} from './source-context-lineage.js';
import {fileAttachmentAvailable} from './file-attachments.js';

export type ConversationScope = Pick<QueryInput,'after'|'before'|'deviceId'|'timeZone'|'evidenceIds'|'anchorEvidenceIds'|'anchorMaterialRef'> & {kind?:'all'|'selection';sourceIds?:string[]};
export type ConversationStatus = 'accepted'|'queued'|'running'|'completed'|'failed'|'cancelled';
type Attachment = {id:string;name:string;mimeType:string};
type Failure = {code:string;message:string};
export type ConversationTurn = {id:string;seq:number;question:string;scope:ConversationScope;result?:QueryResult;status:ConversationStatus;version:number;clientRequestId?:string;runId?:string;error?:Failure;createdAt:string;modelProfileId?:string;modelOverride?:string;evidenceDeleted?:boolean;evidenceStale?:boolean;evidenceUnavailable?:boolean;unavailableEvidenceIds?:string[];historyEvidenceDependencies?:QueryResult['evidenceDependencies'];attachments?:Attachment[]};
export type ConversationMessage = ConversationTurn & {conversationId:string};
export type ConversationSummary = {id:string;title:string;createdAt:string;updatedAt:string;turnCount:number;scope:ConversationScope;status:ConversationStatus};
export type Conversation = ConversationSummary & {turns:ConversationTurn[];revision?:number};
type NewTurn = Omit<ConversationTurn,'seq'>;
type Row = {id:string;title:string;created_at:string;updated_at:string;json:string};

const scopeKeys=['after','before','deviceId','timeZone','evidenceIds','anchorEvidenceIds','anchorMaterialRef','kind','sourceIds'] as const;
const terminalStatus="coalesce(json_extract(json,'$.status'),'completed') IN ('completed','failed','cancelled')";
const pendingStatus=(prefix='')=>`json_extract(${prefix}json,'$.status') IN ('accepted','queued','running')`;
const scopeOf=(input:ConversationScope):ConversationScope=>{
  const scope:ConversationScope={};
  for(const key of scopeKeys){
    const value=input[key];
    if(value!==undefined)Object.assign(scope,{[key]:Array.isArray(value)?[...value]:value});
  }
  return scope;
};

/** Owner-only conversations share the vault's private SQLite backup and quota. */
export class Conversations {
  onTurnReceived?:(turnId:string,conversationId:string)=>void;
  private readonly sourceContexts:SourceContextStore;
  constructor(private readonly store:Store) {
    this.sourceContexts=new SourceContextStore(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS conversation_turns(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,idx INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,json TEXT NOT NULL,PRIMARY KEY(conversation_id,idx));
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_client_request ON conversation_turns(json_extract(json,'$.clientRequestId')) WHERE json_extract(json,'$.clientRequestId') IS NOT NULL;`);
    store.installContextHistoryInvalidation();
    // Capture original permission roots before subsequent cache eviction can
    // remove a derived node. Do not reconstruct already-erased answer content.
    store.db.exec('SAVEPOINT conversation_history_receipts');
    try{
      for(const row of store.db.prepare("SELECT id,conversation_id,json FROM conversation_turns WHERE json_extract(json,'$.result') IS NOT NULL AND coalesce(json_extract(json,'$.evidenceDeleted'),0)!=1 AND json_extract(json,'$.historyEvidenceDependencies') IS NULL").all()){
        const turn=JSON.parse(String(row.json)) as ConversationTurn,receipt=historyEvidenceDependencies(store,resolveDependencies(store,turn.result?.evidenceDependencies));
        if(!receipt)continue;
        const growth=Buffer.byteLength(JSON.stringify({...turn,historyEvidenceDependencies:receipt}))-Buffer.byteLength(String(row.json));
        store.reserveMetadata(Math.max(0,growth));
        store.db.prepare("UPDATE conversation_turns SET json=json_set(json,'$.historyEvidenceDependencies',json(?)) WHERE id=?").run(JSON.stringify(receipt),row.id);
        store.db.prepare("UPDATE conversations SET json=json_set(json,'$.bytes',coalesce(json_extract(json,'$.bytes'),0)+?) WHERE id=?").run(growth,row.conversation_id);
      }
      store.db.exec('RELEASE conversation_history_receipts');
    }catch(error){store.db.exec('ROLLBACK TO conversation_history_receipts; RELEASE conversation_history_receipts');throw error;}
  }

  list({limit=50,cursor}:{limit?:number;cursor?:string}={}) {
    let where='';const values:(string|number)[]=[];
    if(cursor) {
      try {
        const value=JSON.parse(Buffer.from(cursor,'base64url').toString()) as {at?:unknown;id?:unknown};
        if(typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at))||typeof value.id!=='string'||value.id.length!==36)throw Error();
        where='WHERE (updated_at < ? OR (updated_at = ? AND id < ?))';values.push(value.at,value.at,value.id);
      }catch{throw new StoreError('Invalid conversation cursor');}
    }
    const rows=this.store.db.prepare(`SELECT id,title,created_at,updated_at,json_extract(json,'$.scope') AS scope,(SELECT count(*) FROM conversation_turns t WHERE t.conversation_id=conversations.id) AS turn_count,json_extract(json,'$.status') AS last_turn_status FROM conversations ${where} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...values,limit+1) as {id:string;title:string;created_at:string;updated_at:string;scope:string;turn_count:number;last_turn_status:string|null}[];
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page.map(row=>({id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:JSON.parse(row.scope),turnCount:row.turn_count,status:['failed','accepted','queued','running','cancelled'].includes(row.last_turn_status??'')?row.last_turn_status:'completed'}) as ConversationSummary),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.updated_at,id:last.id})).toString('base64url'):null};
  }

  get(id:string):Conversation {return this.read(id);}
  /** Create an empty side conversation; product admission is checked by the route. */
  create():{id:string} {return this.transaction(()=>this.createEmpty());}
  private createEmpty():{id:string} {
    const id=randomUUID(),now=new Date().toISOString();
    this.store.reserveMetadata(512);
    this.store.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,json) VALUES(?,?,?,?,?)').run(id,'',now,now,JSON.stringify({scope:{},turnCount:0,status:'completed',bytes:0,revision:0,nextSeq:0}));
    return {id};
  }
  /** Select an existing conversation, without changing its contents or any other conversation. */
  selectMain(id:string):{id:string} {
    return this.transaction(()=>{
      if(!this.store.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id))throw new StoreError('Conversation not found',404);
      this.store.db.prepare("INSERT INTO settings(key,value) VALUES('main-conversation-id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
      return {id};
    });
  }
  /** A stable, owner-local identity; deleting the conversation starts a new one. */
  main():{id:string} {
    return this.transaction(()=>{
      const saved=this.store.db.prepare("SELECT value FROM settings WHERE key='main-conversation-id'").get();
      const id=saved&&String(saved.value);
      if(id&&this.store.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id))return {id};
      const next=this.createEmpty();
      this.store.db.prepare("INSERT INTO settings(key,value) VALUES('main-conversation-id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(next.id);
      return next;
    });
  }
  message(id:string):ConversationMessage {const row=this.messageRow(id);return {conversationId:row.conversation_id,...JSON.parse(row.json) as ConversationTurn};}
  hasMessage(id:string):boolean{return Boolean(this.store.db.prepare('SELECT 1 FROM conversation_turns WHERE id=?').get(id));}
  messageByClientRequestId(id:string):ConversationMessage|undefined {
    const row=this.store.db.prepare("SELECT conversation_id,json FROM conversation_turns WHERE json_extract(json,'$.clientRequestId')=?").get(id) as {conversation_id:string;json:string}|undefined;
    return row?{conversationId:row.conversation_id,...JSON.parse(row.json) as ConversationTurn}:undefined;
  }
  messageForRun(runId:string):ConversationMessage|undefined {
    const row=this.store.db.prepare("SELECT conversation_id,json FROM conversation_turns WHERE json_extract(json,'$.runId')=?").get(runId) as {conversation_id:string;json:string}|undefined;
    return row?{conversationId:row.conversation_id,...JSON.parse(row.json) as ConversationTurn}:undefined;
  }
  referenceAvailability(id:string,evidenceId:string){
    const conversation=this.get(id);
    const retained=conversation.turns.some(turn=>!turn.evidenceDeleted&&Boolean(turn.result)&&[...turn.result!.citations.map(citation=>citation.id),...(turn.scope.evidenceIds??[]),...(turn.scope.anchorEvidenceIds??[])].includes(evidenceId));
    return {id:evidenceId,available:retained&&!unavailableHistoryEvidence(this.store,[evidenceId]).length};
  }
  /** The exclusive sequence cursor remains valid if other turns are inserted or deleted. */
  page(id:string,{limit=20,cursor,anchor}:{limit?:number;cursor?:string;anchor?:string}={}){
    if(cursor!==undefined&&(!/^(0|[1-9]\d*)$/.test(cursor)||!Number.isSafeInteger(Number(cursor))))throw new StoreError('Invalid turn cursor');
    if(cursor!==undefined&&anchor!==undefined)throw new StoreError('Choose a cursor or an anchor');
    let before=cursor===undefined?undefined:Number(cursor);
    if(anchor!==undefined){
      const row=this.store.db.prepare('SELECT idx FROM conversation_turns WHERE conversation_id=? AND id=?').get(id,anchor);
      if(!row)throw new StoreError('Conversation message not found',404);
      before=Number(row.idx)+1;
    }
    const size=Math.max(1,Math.min(Math.trunc(limit),50));
    const value=this.read(id,size+1,before,true),hasMore=value.turns.length>size;
    if(hasMore)value.turns.shift();
    const oldest=value.turns[0]?.seq;
    return {...value,firstIndex:oldest??0,nextCursor:hasMore&&oldest!==undefined?String(oldest):null};
  }
  private visibleTurn(value:ConversationTurn):ConversationTurn {
    let turn=value;
    // A submitted reference is dialogue input even when no retrieval tool was
    // called. Derive missing pins at read time as well as at publication, so
    // existing user messages cannot become untracked summary inputs.
    if(turn.result&&!turn.evidenceDeleted){
      const explicit=[...(turn.scope.evidenceIds??[]),...(turn.scope.anchorEvidenceIds??[]),...(turn.attachments?.map(attachment=>attachment.id)??[])];
      if(turn.scope.anchorMaterialRef||explicit.some(id=>!turn.result!.evidenceDependencies?.ids.includes(id))){
        const evidenceDependencies=this.messageDependencies(turn.result.evidenceDependencies,turn.scope,turn.attachments);
        if(evidenceDependencies){
          const history=historyEvidenceDependencies(this.store,evidenceDependencies,[turn]);
          turn={...turn,result:{...turn.result,evidenceDependencies},...(history?{historyEvidenceDependencies:history}:{})};
        }
      }
    }
    if(turn.attachments?.length){
      const visible=turn.attachments.flatMap(attachment=>{
        const record=this.store.evidenceMetadata([attachment.id])[0];
        if(!record||record.privacy.excluded||!this.store.isCurrentEvidence(attachment.id)||!fileAttachmentAvailable(this.store,attachment.id,true)||unavailableHistoryEvidence(this.store,[attachment.id]).length)return [];
        if(attachment.name&&attachment.mimeType)return [attachment];
        const file=this.store.db.prepare("SELECT json_extract(manifest,'$.item.title') name,json_extract(manifest,'$.item.mimeType') mimeType FROM file_versions WHERE capture_id=?").get(attachment.id);
        return [{id:attachment.id,name:String(file?.name||'Attached image'),mimeType:String(file?.mimeType??'')}];
      });
      turn={...turn,attachments:visible};
    }
    if(!turn.evidenceDeleted&&turn.result){
      const result=turn.result;
      if(!sourceContextDependenciesCurrent(this.sourceContexts,result.sourceContextDependencies))turn={...turn,evidenceStale:true};
      const unavailableEvidenceIds=unavailableHistoryEvidence(this.store,[...result.citations.map(cite=>cite.id),...(turn.scope.evidenceIds??[]),...(turn.scope.anchorEvidenceIds??[])]);
      if(unavailableEvidenceIds.length)turn={...turn,unavailableEvidenceIds};
    }
    return turn;
  }
  private read(id:string,limit?:number,before?:number,includePending=false):Conversation&{firstIndex:number} {
    const row=this.store.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new StoreError('Conversation not found',404);
    const value=JSON.parse(row.json);
    const high=before??Number(this.store.db.prepare('SELECT coalesce(max(idx),-1)+1 AS n FROM conversation_turns WHERE conversation_id=?').get(id)?.n??0);
    const rows=this.store.db.prepare(`SELECT idx,json FROM conversation_turns WHERE conversation_id=? AND idx<? ${includePending?'':`AND ${terminalStatus}`} ORDER BY idx DESC LIMIT ?`).all(id,high,limit??-1).reverse();
    const turns=rows.map(r=>this.visibleTurn(JSON.parse(String(r.json)) as ConversationTurn));
    const turnCount=includePending?Number(this.store.db.prepare('SELECT count(*) n FROM conversation_turns WHERE conversation_id=?').get(id)?.n??0):value.turnCount;
    return {id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:value.scope,turnCount,status:value.status??'completed',revision:value.revision,turns,firstIndex:Number(rows[0]?.idx??0)};
  }

  /** Persist the owner's exact input before any execution is attempted. A lost
   * response may retry the same clientRequestId; a different body is a conflict.
   * Sequence numbers are assigned inside the write transaction and are unique
   * per conversation, including accepted messages that are not yet answers. */
  receive(input:ConversationScope&{question:string;conversationId?:string;clientRequestId?:string;attachments?:Attachment[];modelProfileId?:string;modelOverride?:string}):ConversationMessage {
    const question=input.question,scope=scopeOf(input),modelProfileId=input.modelProfileId,modelOverride=input.modelOverride;
    const attachments=input.attachments?.length?input.attachments.map(item=>({...item})):undefined;
    if(typeof question!=='string'||!question.trim())throw new StoreError('Conversation message requires a question',400);
    if(input.clientRequestId!==undefined&&(typeof input.clientRequestId!=='string'||!input.clientRequestId||input.clientRequestId.length>200))throw new StoreError('Invalid client request id',400);
    const now=new Date().toISOString();
    return this.transaction(()=>{
      if(input.clientRequestId){
        const existing=this.store.db.prepare("SELECT conversation_id,json FROM conversation_turns WHERE json_extract(json,'$.clientRequestId')=? LIMIT 1").get(input.clientRequestId) as {conversation_id:string;json:string}|undefined;
        if(existing){
          const message=JSON.parse(existing.json) as ConversationTurn;
          if((input.conversationId&&input.conversationId!==existing.conversation_id)||message.question!==question||JSON.stringify(scopeOf(message.scope))!==JSON.stringify(scope)||JSON.stringify(message.attachments??null)!==JSON.stringify(attachments??null)||message.modelProfileId!==modelProfileId||message.modelOverride!==modelOverride)throw new StoreError('clientRequestId belongs to a different message',409);
          return {conversationId:existing.conversation_id,...message};
        }
      }
      const conversationId=input.conversationId??randomUUID();
      const conversation=input.conversationId?this.store.db.prepare('SELECT json FROM conversations WHERE id=?').get(conversationId) as {json:string}|undefined:undefined;
      if(input.conversationId&&!conversation)throw new StoreError('Conversation not found',404);
      const message:ConversationTurn={id:randomUUID(),seq:this.nextSeq(conversationId),question,scope,status:'accepted',version:1,...(input.clientRequestId?{clientRequestId:input.clientRequestId}:{}),...(modelProfileId?{modelProfileId}:{}),...(modelOverride?{modelOverride}:{}),...(attachments?.length?{attachments}:{}),createdAt:now};
      const json=JSON.stringify(message),size=Buffer.byteLength(json);
      this.store.reserveMetadata(size+512);
      if(conversation)this.store.db.prepare("UPDATE conversations SET title=CASE WHEN title='' THEN ? ELSE title END,updated_at=?,json=json_set(json,'$.bytes',coalesce(json_extract(json,'$.bytes'),0)+?,'$.status','accepted','$.nextSeq',?) WHERE id=?").run(Array.from(question).slice(0,80).join(''),now,size,message.seq+1,conversationId);
      else this.store.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,json) VALUES(?,?,?,?,?)').run(conversationId,Array.from(question).slice(0,80).join(''),now,now,JSON.stringify({scope,turnCount:0,status:'accepted',bytes:size,revision:0,nextSeq:message.seq+1}));
      this.store.db.prepare('INSERT INTO conversation_turns VALUES(?,?,?,?)').run(conversationId,message.seq,message.id,json);
      return {conversationId,...message};
    });
  }

  /** Accepted and queued messages in server order, including after restart. */
  pending({conversationId,limit=50}:{conversationId?:string;limit?:number}={}):ConversationMessage[] {
    const bounded=Math.max(1,Math.min(Number.isFinite(limit)?Math.trunc(limit):50,100));
    const rows=this.store.db.prepare(`SELECT conversation_id,json FROM conversation_turns WHERE ${conversationId?'conversation_id=? AND ':''}${pendingStatus()} ORDER BY conversation_id,idx LIMIT ?`).all(...(conversationId?[conversationId,bounded]:[bounded])) as {conversation_id:string;json:string}[];
    return rows.map(row=>({conversationId:String(row.conversation_id),...JSON.parse(String(row.json)) as ConversationTurn}));
  }

  /** The earliest unfinished message in each conversation, independent of wall-clock order. */
  pendingHeads():ConversationMessage[] {
    const rows=this.store.db.prepare(`SELECT t.conversation_id,t.json FROM conversation_turns t WHERE ${pendingStatus('t.')}
      AND NOT EXISTS(SELECT 1 FROM conversation_turns p WHERE p.conversation_id=t.conversation_id AND p.idx<t.idx AND ${pendingStatus('p.')}) ORDER BY t.conversation_id,t.idx`).all() as {conversation_id:string;json:string}[];
    return rows.map(row=>({conversationId:row.conversation_id,...JSON.parse(row.json) as ConversationTurn}));
  }

  queue(id:string,{expectedVersion}:{expectedVersion:number}):ConversationMessage {
    return this.transaction(()=>{
      const row=this.messageRow(id),message=JSON.parse(row.json) as ConversationTurn;
      if(message.status==='queued'&&message.version===expectedVersion)return {conversationId:row.conversation_id,...message};
      if(message.status!=='accepted')throw new StoreError('Conversation message is not awaiting queueing',409);
      if(message.version!==expectedVersion)throw new StoreError('Conversation message changed; reload and retry',409);
      const next:ConversationTurn={...message,status:'queued',version:message.version+1};
      return {conversationId:row.conversation_id,...this.rewrite(row.conversation_id,next,row.json)};
    });
  }

  attachRun(id:string,runId:string,{expectedVersion}:{expectedVersion:number}):ConversationMessage {
    return this.transaction(()=>{
      const row=this.messageRow(id),message=JSON.parse(row.json) as ConversationTurn;
      if(message.runId===runId)return {conversationId:row.conversation_id,...message};
      if(message.status!=='accepted'&&message.status!=='queued')throw new StoreError('Conversation message is not awaiting a run',409);
      if(message.version!==expectedVersion)throw new StoreError('Conversation message changed; reload and retry',409);
      const next:ConversationTurn={...message,status:'queued',runId,version:message.version+1};
      return {conversationId:row.conversation_id,...this.rewrite(row.conversation_id,next,row.json)};
    });
  }

  running(id:string,{expectedVersion}:{expectedVersion:number}):ConversationMessage {
    return this.transaction(()=>{
      const row=this.messageRow(id),message=JSON.parse(row.json) as ConversationTurn;
      if(message.status==='running'&&message.version===expectedVersion)return {conversationId:row.conversation_id,...message};
      if(message.status!=='queued'||!message.runId||message.version!==expectedVersion)throw new StoreError('Conversation message changed; reload and retry',409);
      return {conversationId:row.conversation_id,...this.rewrite(row.conversation_id,{...message,status:'running',version:message.version+1},row.json)};
    });
  }

  cancel(id:string):ConversationMessage {
    return this.transaction(()=>{
      const row=this.messageRow(id),message=JSON.parse(row.json) as ConversationTurn;
      if(message.status==='cancelled')return {conversationId:row.conversation_id,...message};
      if(!['accepted','queued','running'].includes(message.status))throw new StoreError('Conversation message is already finished',409);
      const cancelled:ConversationTurn={...message,status:'cancelled',version:message.version+1};
      delete cancelled.result;delete cancelled.error;
      return {conversationId:row.conversation_id,...this.rewriteTerminal(row.conversation_id,cancelled,row.json)};
    });
  }

  /** The submitted reference identities are part of the user's original
   * message, even when the model did not cite or reopen those originals. */
  private messageDependencies(value:QueryResult['evidenceDependencies'],scope:ConversationScope,attachments?:Attachment[]){
    const ids=[...(value?.ids??[]),...(scope.evidenceIds??[]),...(scope.anchorEvidenceIds??[]),...(attachments?.map(attachment=>attachment.id)??[])];
    let complete=value?.complete??false;
    if(scope.anchorMaterialRef){
      const match=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/.exec(scope.anchorMaterialRef);
      const installed=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_evidence'").get();
      if(!match||!installed)complete=false;
      else{
        const anchors=this.store.db.prepare(`SELECT anchor_id id FROM material_blocks WHERE material_id=? AND revision=? AND anchor_id IS NOT NULL
          UNION SELECT b.anchor_id id FROM material_block_versions b JOIN material_revisions r ON r.material_id=b.material_id AND r.revision=?
          WHERE b.material_id=? AND b.from_sequence<=r.sequence AND (b.until_sequence IS NULL OR b.until_sequence>r.sequence) AND b.anchor_id IS NOT NULL`).all(match[1],match[2],match[2],match[1]);
        if(!anchors.length)complete=false;
        ids.push(...anchors.map(row=>String(row.id)));
      }
    }
    if(!value&&!ids.length&&!scope.anchorMaterialRef)return;
    return resolveDependencies(this.store,{version:1,complete,ids:[...new Set(ids)]});
  }

  complete(id:string,result:QueryResult,{expectedVersion}:{expectedVersion:number}):ConversationMessage {
    assertSourceContextDependencies(this.sourceContexts,result.sourceContextDependencies);
    return this.transaction(()=>{
      const row=this.messageRow(id),message=JSON.parse(row.json) as ConversationTurn;
      if(message.status==='completed'){
        if(message.result?.runId===result.runId)return {conversationId:row.conversation_id,...message};
        throw new StoreError('Conversation message already completed',409);
      }
      if(!['accepted','queued','running'].includes(message.status))throw new StoreError('Conversation message is not awaiting a result',409);
      if(message.version!==expectedVersion)throw new StoreError('Conversation message changed; reload and retry',409);
      const evidenceDependencies=this.messageDependencies(result.evidenceDependencies,message.scope,message.attachments);
      const history=historyEvidenceDependencies(this.store,evidenceDependencies,this.previousTurns(row.conversation_id,id));
      const completed:ConversationTurn={...message,status:'completed',version:message.version+1,result:{...result,...(evidenceDependencies?{evidenceDependencies}:{})},...(history?{historyEvidenceDependencies:history}:{})};
      delete completed.error;
      return {conversationId:row.conversation_id,...this.rewriteTerminal(row.conversation_id,completed,row.json)};
    });
  }

  fail(id:string,error:Failure,{expectedVersion}:{expectedVersion:number}):ConversationMessage {
    return this.transaction(()=>{
      const row=this.messageRow(id),message=JSON.parse(row.json) as ConversationTurn;
      if(message.status==='failed'){
        if(message.error?.code===error.code&&message.error.message===error.message)return {conversationId:row.conversation_id,...message};
        throw new StoreError('Conversation message already failed',409);
      }
      if(!['accepted','queued','running'].includes(message.status))throw new StoreError('Conversation message is not awaiting a result',409);
      if(message.version!==expectedVersion)throw new StoreError('Conversation message changed; reload and retry',409);
      const failed:ConversationTurn={...message,status:'failed',version:message.version+1,error};
      delete failed.result;
      return {conversationId:row.conversation_id,...this.rewriteTerminal(row.conversation_id,failed,row.json)};
    });
  }

  append(previous:Conversation|undefined,input:ConversationScope&{question:string;attachments?:Attachment[]},result:QueryResult) {
    assertSourceContextDependencies(this.sourceContexts,result.sourceContextDependencies);
    const {question,attachments,...scope}=input,now=new Date().toISOString();
    const evidenceDependencies=this.messageDependencies(result.evidenceDependencies,scope,attachments);
    const history=historyEvidenceDependencies(this.store,evidenceDependencies,previous?.turns);
    const turn:NewTurn={id:randomUUID(),question,scope,version:1,result:{...result,...(evidenceDependencies?{evidenceDependencies}:{})},status:'completed',createdAt:now,...(history?{historyEvidenceDependencies:history}:{}),...(attachments?.length?{attachments}:{})};
    return this.write(previous,turn);
  }

  appendFailure(previous:Conversation|undefined,input:ConversationScope&{question:string},error:Failure) {
    const {question,...scope}=input,now=new Date().toISOString();
    const turn:NewTurn={id:randomUUID(),question,scope,version:1,status:'failed',error,createdAt:now};
    return this.write(previous,turn);
  }

  private messageRow(id:string){const row=this.store.db.prepare('SELECT conversation_id,json FROM conversation_turns WHERE id=?').get(id) as {conversation_id:string;json:string}|undefined;if(!row)throw new StoreError('Conversation message not found',404);return row;}
  private nextSeq(conversationId:string){return Number(this.store.db.prepare("SELECT max(coalesce((SELECT json_extract(json,'$.nextSeq') FROM conversations WHERE id=?),0),coalesce(max(idx),-1)+1) AS n FROM conversation_turns WHERE conversation_id=?").get(conversationId,conversationId)?.n??0);}
  private previousTurns(conversationId:string,exclude:string){return this.store.db.prepare(`SELECT json FROM conversation_turns WHERE conversation_id=? AND idx<(SELECT idx FROM conversation_turns WHERE id=?) AND ${terminalStatus} ORDER BY idx`).all(conversationId,exclude).map(row=>JSON.parse(String(row.json)) as ConversationTurn);}
  private rewrite(conversationId:string,message:ConversationTurn,previous:string){
    const json=JSON.stringify(message),growth=Buffer.byteLength(json)-Buffer.byteLength(previous);
    this.store.reserveMetadata(Math.max(0,growth));
    this.store.db.prepare('UPDATE conversation_turns SET json=? WHERE id=?').run(json,message.id);
    this.store.db.prepare("UPDATE conversations SET json=json_set(json,'$.bytes',coalesce(json_extract(json,'$.bytes'),0)+?,'$.status',(SELECT coalesce(json_extract(json,'$.status'),'completed') FROM conversation_turns WHERE conversation_id=? ORDER BY idx DESC LIMIT 1)) WHERE id=?").run(growth,conversationId,conversationId);
    return message;
  }
  private rewriteTerminal(conversationId:string,message:ConversationTurn,previous:string){
    const now=new Date().toISOString(),json=JSON.stringify(message),growth=Buffer.byteLength(json)-Buffer.byteLength(previous);
    this.store.reserveMetadata(Math.max(0,growth)+256);
    this.store.db.prepare('UPDATE conversation_turns SET json=? WHERE id=?').run(json,message.id);
    this.store.db.prepare("UPDATE conversations SET updated_at=?,json=json_set(json,'$.scope',json(?),'$.bytes',coalesce(json_extract(json,'$.bytes'),0)+?,'$.turnCount',coalesce(json_extract(json,'$.turnCount'),0)+1,'$.status',(SELECT coalesce(json_extract(json,'$.status'),'completed') FROM conversation_turns WHERE conversation_id=? ORDER BY idx DESC LIMIT 1),'$.revision',coalesce(json_extract(json,'$.revision'),0)+1) WHERE id=?").run(now,JSON.stringify(message.scope),growth,conversationId,conversationId);
    inheritRetiredConversationRoots(this.store,conversationId,message);
    if(message.status!=='cancelled')this.onTurnReceived?.(message.id,conversationId);
    return message;
  }
  private transaction<T>(write:()=>T):T{
    const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
    try{const value=write();if(own)this.store.db.exec('COMMIT');return value;}
    catch(error){if(own&&this.store.db.isTransaction)this.store.db.exec('ROLLBACK');throw error;}
  }

  private write(previous:Conversation|undefined,turn:NewTurn) {
    const now=turn.createdAt;
    const question=turn.question;
    const id=previous?.id??randomUUID(),title=previous?.title||Array.from(question).slice(0,80).join('');
    return this.transaction(()=>{
      const existing=this.store.db.prepare('SELECT json,updated_at FROM conversations WHERE id=?').get(id) as {json:string;updated_at:string}|undefined;
      const meta=existing?JSON.parse(String(existing.json)) as {turnCount?:number;bytes?:number;revision?:number;workingContextStartSeq?:number;workingContextVersion?:number}:undefined;
      if(previous&&(!meta||meta.turnCount!==previous.turnCount||meta.revision!==previous.revision||existing!.updated_at!==previous.updatedAt))throw new StoreError('Conversation changed during this answer; reload and retry',409);
      const count=meta?.turnCount??0,seq=this.nextSeq(id),stored={...turn,seq} as ConversationTurn,json=JSON.stringify(stored),size=Buffer.byteLength(json);
      this.store.reserveMetadata(size+512);
      this.store.db.prepare("INSERT INTO conversations(id,title,created_at,updated_at,json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=CASE WHEN conversations.title='' THEN excluded.title ELSE conversations.title END,updated_at=excluded.updated_at,json=excluded.json").run(id,title,previous?.createdAt??now,now,JSON.stringify({scope:stored.scope,turnCount:count+1,status:stored.status,bytes:(meta?.bytes??0)+size,revision:(meta?.revision??0)+1,nextSeq:seq+1,...(meta?.workingContextStartSeq!==undefined?{workingContextStartSeq:meta.workingContextStartSeq}:{}),...(meta?.workingContextVersion!==undefined?{workingContextVersion:meta.workingContextVersion}:{})}));
      this.store.db.prepare('INSERT INTO conversation_turns VALUES(?,?,?,?)').run(id,seq,stored.id,json);
      inheritRetiredConversationRoots(this.store,id,stored);
      this.onTurnReceived?.(stored.id,id);
      return {conversationId:id,turnId:stored.id};
    });
  }

  delete(id:string) {
    const db=this.store.db;db.exec('SAVEPOINT delete_conversation');
    try{
      // Public status messages can contain derived facts; remove them with the dialogue.
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='query_runs'").get())db.prepare("DELETE FROM query_runs WHERE json_extract(json,'$.conversationId')=?").run(id);
      const deleted=Number(db.prepare('DELETE FROM conversations WHERE id=?').run(id).changes);
      db.exec('DELETE FROM conversation_retired_roots WHERE NOT EXISTS(SELECT 1 FROM conversation_retired_turn_roots r WHERE r.evidence_id=conversation_retired_roots.id)');
      db.exec('RELEASE delete_conversation');return {deleted};
    }catch(error){db.exec('ROLLBACK TO delete_conversation; RELEASE delete_conversation');throw error;}
  }

  historyContext(conversation:Conversation,turns:readonly ConversationTurn[]=conversation.turns):NonNullable<QueryInput['historyContext']>{
    const active=turns.filter(turn=>turn.result&&!turn.evidenceDeleted);
    return {conversationId:conversation.id,revision:this.historyRevision(active),turns:active.map(turn=>({id:turn.id,runId:turn.result!.runId})),evidenceDependencies:combineDependencies(active.map(turn=>turn.historyEvidenceDependencies))??{version:1,complete:!active.length,ids:[]}};
  }
  private historyRevision(turns:readonly ConversationTurn[]){return Number.parseInt(createHash('sha256').update(JSON.stringify(turns)).digest('hex').slice(0,13),16);}
  assertHistoryContext(snapshot:NonNullable<QueryInput['historyContext']>){
    const row=this.store.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(snapshot.conversationId);
    if(!row)throw new StoreError('Conversation changed; its context is no longer available',409);
    if(!Array.isArray(snapshot.turns)||new Set(snapshot.turns.map(turn=>turn.id)).size!==snapshot.turns.length)throw new StoreError('Invalid conversation history receipt',409);
    const selected=this.store.db.prepare('SELECT id,json FROM conversation_turns WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?))').all(snapshot.conversationId,JSON.stringify(snapshot.turns.map(turn=>turn.id)));
    const byId=new Map(selected.map(value=>[String(value.id),this.visibleTurn(JSON.parse(String(value.json)) as ConversationTurn)]));
    const turns=snapshot.turns.map(pin=>byId.get(pin.id));
    if(turns.some((turn,index)=>!turn||turn.evidenceDeleted||!turn.result||snapshot.turns[index].runId!==turn.result.runId))throw new StoreError('Conversation history lineage changed',409);
    const current=turns as ConversationTurn[];
    const expected=combineDependencies(current.map(turn=>turn.historyEvidenceDependencies))??{version:1,complete:!current.length,ids:[]};
    if(snapshot.evidenceDependencies.version!==1||snapshot.evidenceDependencies.complete!==expected.complete||JSON.stringify([...new Set(snapshot.evidenceDependencies.ids)].sort())!==JSON.stringify([...new Set(expected.ids)].sort()))throw new StoreError('Conversation history lineage changed',409);
    if(this.historyRevision(current)!==snapshot.revision)throw new StoreError('Conversation changed; its context is no longer current',409);
    return new Set(this.store.db.prepare(`SELECT DISTINCT r.evidence_id FROM conversation_retired_turn_roots r JOIN conversation_turns t ON t.id=r.turn_id
      WHERE r.conversation_id=? AND r.turn_id IN (SELECT value FROM json_each(?)) AND r.result_run_id=json_extract(t.json,'$.result.runId')
       AND EXISTS(SELECT 1 FROM json_each(t.json,'$.historyEvidenceDependencies.ids') d WHERE d.value=r.evidence_id)`).all(snapshot.conversationId,JSON.stringify(snapshot.turns.map(turn=>turn.id))).map(value=>String(value.evidence_id)));

  }

  retiredSelection(snapshot:NonNullable<QueryInput['historyContext']>,ids:readonly string[]){
    const proofs=this.assertHistoryContext(snapshot);
    return new Set(ids.filter(id=>proofs.has(id)));
  }

  context(conversation:Conversation,maxTurns=20,maxCharacters=60000):NonNullable<QueryInput['conversation']> {
    const turns:NonNullable<QueryInput['conversation']>['turns']=[];
    const dependencies:QueryResult['evidenceDependencies'][]=[];
    const sourcePins:QueryResult['sourceContextDependencies'][]=[];
    const selected:ConversationTurn[]=[];
    let length=0;
    const completedTurns=conversation.turns.filter(turn=>turn.status!=='failed'&&turn.result).length;
    for(const turn of [...conversation.turns].reverse()) {
      if(turn.status==='failed'||!turn.result)continue;

      const contextStale=!sourceContextDependenciesCurrent(this.sourceContexts,turn.result.sourceContextDependencies);
      const answer=turn.result.answer.slice(0,20000);
      const value={question:turn.question,answer,scope:turn.scope,createdAt:turn.createdAt,...(answer.length<turn.result.answer.length?{answerTruncated:true}:{}),...(contextStale?{contextStale:true}:{}),...(turn.evidenceStale?{evidenceStale:true}:{}),...(turn.evidenceUnavailable?{evidenceUnavailable:true}:{}),...(turn.evidenceDeleted?{evidenceDeleted:true}:{}),...(turn.attachments?.length?{attachments:turn.attachments}:{})};
      const size=JSON.stringify(value).length;
      if(turns.length===maxTurns||length+size>maxCharacters)break;
      turns.unshift(value);selected.push(turn);length+=size;
      dependencies.push(turn.evidenceDeleted?{version:1,complete:true,ids:[]}:turn.result.evidenceDependencies);
      if(!turn.evidenceDeleted&&!contextStale)sourcePins.push(turn.result.sourceContextDependencies);
    }
    const evidenceDependencies=combineDependencies(dependencies);
    const sourceContextDependencies=combineSourceContextDependencies(sourcePins);
    return {turns,omittedTurns:completedTurns-turns.length,historyContext:this.historyContext(conversation,selected),...(evidenceDependencies?{evidenceDependencies}:{}),...(sourceContextDependencies.length?{sourceContextDependencies}:{})};
  }
}
