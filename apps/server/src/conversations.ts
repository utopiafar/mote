import {inheritRetiredConversationRoots,unavailableHistoryEvidence} from './conversation-retention.js';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store,StoreError} from './store.js';
import {combineDependencies,resolveDependencies,historyEvidenceDependencies} from './conversation-lineage.js';
import {SourceContextStore} from './source-context.js';
import {assertSourceContextDependencies,combineSourceContextDependencies,sourceContextDependenciesCurrent} from './source-context-lineage.js';

export type ConversationScope = Pick<QueryInput,'after'|'before'|'deviceId'|'timeZone'|'evidenceIds'|'anchorEvidenceIds'|'anchorMaterialRef'>;
export type ConversationStatus = 'accepted'|'queued'|'completed'|'failed';
type Attachment = {id:string;name:string;mimeType:string};
type Failure = {code:string;message:string};
export type ConversationTurn = {id:string;seq:number;question:string;scope:ConversationScope;result?:QueryResult;status:ConversationStatus;version:number;clientRequestId?:string;runId?:string;error?:Failure;createdAt:string;evidenceDeleted?:boolean;evidenceStale?:boolean;evidenceUnavailable?:boolean;unavailableEvidenceIds?:string[];historyEvidenceDependencies?:QueryResult['evidenceDependencies'];attachments?:Attachment[]};
export type ConversationMessage = ConversationTurn & {conversationId:string};
export type ConversationSummary = {id:string;title:string;createdAt:string;updatedAt:string;turnCount:number;scope:ConversationScope;status:ConversationStatus};
export type Conversation = ConversationSummary & {turns:ConversationTurn[];revision?:number};
type NewTurn = Omit<ConversationTurn,'seq'>;
type Row = {id:string;title:string;created_at:string;updated_at:string;json:string};

const scopeKeys=['after','before','deviceId','timeZone','evidenceIds','anchorEvidenceIds','anchorMaterialRef'] as const;
const terminalStatus="coalesce(json_extract(json,'$.status'),'completed') IN ('completed','failed')";
const pendingStatus="json_extract(json,'$.status') IN ('accepted','queued')";
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
    const rows=this.store.db.prepare(`SELECT id,title,created_at,updated_at,json_extract(json,'$.scope') AS scope,json_extract(json,'$.turnCount') AS turn_count,json_extract(json,'$.status') AS last_turn_status FROM conversations ${where} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...values,limit+1) as {id:string;title:string;created_at:string;updated_at:string;scope:string;turn_count:number;last_turn_status:string|null}[];
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page.map(row=>({id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:JSON.parse(row.scope),turnCount:row.turn_count,status:row.last_turn_status==='failed'||row.last_turn_status==='accepted'||row.last_turn_status==='queued'?row.last_turn_status:'completed'}) as ConversationSummary),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.updated_at,id:last.id})).toString('base64url'):null};
  }

  get(id:string):Conversation {return this.read(id);}
  referenceAvailability(id:string,evidenceId:string){
    const conversation=this.get(id);
    const retained=conversation.turns.some(turn=>!turn.evidenceDeleted&&Boolean(turn.result)&&[...turn.result!.citations.map(citation=>citation.id),...(turn.scope.evidenceIds??[]),...(turn.scope.anchorEvidenceIds??[])].includes(evidenceId));
    return {id:evidenceId,available:retained&&!unavailableHistoryEvidence(this.store,[evidenceId]).length};
  }
  /** UI reads only the requested page. Cursor is the exclusive older turn index. */
  page(id:string,{limit=20,cursor}:{limit?:number;cursor?:string}={}){
    if(cursor!==undefined&&!/^\d{1,9}$/.test(cursor))throw new StoreError('Invalid turn cursor');
    const value=this.read(id,Math.max(1,Math.min(limit,50)),cursor===undefined?undefined:Number(cursor));
    const oldest=(value as Conversation&{firstIndex?:number}).firstIndex??0;
    return {...value,nextCursor:oldest>0?String(oldest):null};
  }
  private read(id:string,limit?:number,before?:number):Conversation&{firstIndex:number} {
    const row=this.store.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new StoreError('Conversation not found',404);
    const value=JSON.parse(row.json);
    const high=before??Number(this.store.db.prepare('SELECT coalesce(max(idx),-1)+1 AS n FROM conversation_turns WHERE conversation_id=?').get(id)?.n??0);
    const rows=this.store.db.prepare(`SELECT idx,json FROM conversation_turns WHERE conversation_id=? AND idx<? AND ${terminalStatus} ORDER BY idx DESC LIMIT ?`).all(id,high,limit??-1).reverse();
    const turns=rows.map(r=>{let turn=JSON.parse(String(r.json)) as ConversationTurn;
      if(!turn.evidenceDeleted&&turn.result){
        const result=turn.result;
        if(!sourceContextDependenciesCurrent(this.sourceContexts,turn.result.sourceContextDependencies))turn={...turn,evidenceStale:true};
        const unavailableEvidenceIds=unavailableHistoryEvidence(this.store,[...result.citations.map(cite=>cite.id),...(turn.scope.evidenceIds??[]),...(turn.scope.anchorEvidenceIds??[])]);
        if(unavailableEvidenceIds.length)turn={...turn,unavailableEvidenceIds};
      }
      return turn;
    });
    return {id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:value.scope,turnCount:value.turnCount,status:value.status??'completed',revision:value.revision,turns,firstIndex:Number(rows[0]?.idx??0)};
  }

  /** Persist the owner's exact input before any execution is attempted. A lost
   * response may retry the same clientRequestId; a different body is a conflict.
   * Sequence numbers are assigned inside the write transaction and are unique
   * per conversation, including accepted messages that are not yet answers. */
  receive(input:ConversationScope&{question:string;conversationId?:string;clientRequestId?:string;attachments?:Attachment[]}):ConversationMessage {
    const question=input.question,scope=scopeOf(input);
    const attachments=input.attachments?.length?input.attachments.map(item=>({...item})):undefined;
    if(typeof question!=='string'||!question.trim())throw new StoreError('Conversation message requires a question',400);
    if(input.clientRequestId!==undefined&&(typeof input.clientRequestId!=='string'||!input.clientRequestId||input.clientRequestId.length>200))throw new StoreError('Invalid client request id',400);
    const now=new Date().toISOString();
    return this.transaction(()=>{
      if(input.clientRequestId){
        const existing=this.store.db.prepare("SELECT conversation_id,json FROM conversation_turns WHERE json_extract(json,'$.clientRequestId')=? LIMIT 1").get(input.clientRequestId) as {conversation_id:string;json:string}|undefined;
        if(existing){
          const message=JSON.parse(existing.json) as ConversationTurn;
          if((input.conversationId&&input.conversationId!==existing.conversation_id)||message.question!==question||JSON.stringify(scopeOf(message.scope))!==JSON.stringify(scope)||JSON.stringify(message.attachments??null)!==JSON.stringify(attachments??null))throw new StoreError('clientRequestId belongs to a different message',409);
          return {conversationId:existing.conversation_id,...message};
        }
      }
      const conversationId=input.conversationId??randomUUID();
      const conversation=input.conversationId?this.store.db.prepare('SELECT json FROM conversations WHERE id=?').get(conversationId) as {json:string}|undefined:undefined;
      if(input.conversationId&&!conversation)throw new StoreError('Conversation not found',404);
      const message:ConversationTurn={id:randomUUID(),seq:this.nextSeq(conversationId),question,scope,status:'accepted',version:1,...(input.clientRequestId?{clientRequestId:input.clientRequestId}:{}),...(attachments?.length?{attachments}:{}),createdAt:now};
      const json=JSON.stringify(message),size=Buffer.byteLength(json);
      this.store.reserveMetadata(size+512);
      if(conversation)this.store.db.prepare("UPDATE conversations SET json=json_set(json,'$.bytes',coalesce(json_extract(json,'$.bytes'),0)+?) WHERE id=?").run(size,conversationId);
      else this.store.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,json) VALUES(?,?,?,?,?)').run(conversationId,Array.from(question).slice(0,80).join(''),now,now,JSON.stringify({scope,turnCount:0,status:'accepted',bytes:size,revision:0}));
      this.store.db.prepare('INSERT INTO conversation_turns VALUES(?,?,?,?)').run(conversationId,message.seq,message.id,json);
      return {conversationId,...message};
    });
  }

  /** Accepted and queued messages in server order, including after restart. */
  pending({conversationId,limit=50}:{conversationId?:string;limit?:number}={}):ConversationMessage[] {
    const bounded=Math.max(1,Math.min(Number.isFinite(limit)?Math.trunc(limit):50,100));
    const rows=this.store.db.prepare(`SELECT conversation_id,json FROM conversation_turns WHERE ${conversationId?'conversation_id=? AND ':''}${pendingStatus} ORDER BY json_extract(json,'$.createdAt'),conversation_id,idx LIMIT ?`).all(...(conversationId?[conversationId,bounded]:[bounded])) as {conversation_id:string;json:string}[];
    return rows.map(row=>({conversationId:String(row.conversation_id),...JSON.parse(String(row.json)) as ConversationTurn}));
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

  complete(id:string,result:QueryResult,{expectedVersion}:{expectedVersion:number}):ConversationMessage {
    assertSourceContextDependencies(this.sourceContexts,result.sourceContextDependencies);
    return this.transaction(()=>{
      const row=this.messageRow(id),message=JSON.parse(row.json) as ConversationTurn;
      if(message.status==='completed'){
        if(message.result?.runId===result.runId)return {conversationId:row.conversation_id,...message};
        throw new StoreError('Conversation message already completed',409);
      }
      if(message.status!=='accepted'&&message.status!=='queued')throw new StoreError('Conversation message is not awaiting a result',409);
      if(message.version!==expectedVersion)throw new StoreError('Conversation message changed; reload and retry',409);
      const evidenceDependencies=resolveDependencies(this.store,result.evidenceDependencies);
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
      if(message.status!=='accepted'&&message.status!=='queued')throw new StoreError('Conversation message is not awaiting a result',409);
      if(message.version!==expectedVersion)throw new StoreError('Conversation message changed; reload and retry',409);
      const failed:ConversationTurn={...message,status:'failed',version:message.version+1,error};
      delete failed.result;
      return {conversationId:row.conversation_id,...this.rewriteTerminal(row.conversation_id,failed,row.json)};
    });
  }

  append(previous:Conversation|undefined,input:ConversationScope&{question:string;attachments?:Attachment[]},result:QueryResult) {
    assertSourceContextDependencies(this.sourceContexts,result.sourceContextDependencies);
    const {question,attachments,...scope}=input,now=new Date().toISOString();
    const evidenceDependencies=resolveDependencies(this.store,result.evidenceDependencies);
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
  private nextSeq(conversationId:string){return Number(this.store.db.prepare('SELECT coalesce(max(idx),-1)+1 AS n FROM conversation_turns WHERE conversation_id=?').get(conversationId)?.n??0);}
  private previousTurns(conversationId:string,exclude:string){return this.store.db.prepare(`SELECT json FROM conversation_turns WHERE conversation_id=? AND id<>? AND ${terminalStatus} ORDER BY idx`).all(conversationId,exclude).map(row=>JSON.parse(String(row.json)) as ConversationTurn);}
  private rewrite(conversationId:string,message:ConversationTurn,previous:string){
    const json=JSON.stringify(message),growth=Buffer.byteLength(json)-Buffer.byteLength(previous);
    this.store.reserveMetadata(Math.max(0,growth));
    this.store.db.prepare("UPDATE conversations SET json=json_set(json,'$.bytes',coalesce(json_extract(json,'$.bytes'),0)+?) WHERE id=?").run(growth,conversationId);
    this.store.db.prepare('UPDATE conversation_turns SET json=? WHERE id=?').run(json,message.id);
    return message;
  }
  private rewriteTerminal(conversationId:string,message:ConversationTurn,previous:string){
    const now=new Date().toISOString(),json=JSON.stringify(message),growth=Buffer.byteLength(json)-Buffer.byteLength(previous);
    this.store.reserveMetadata(Math.max(0,growth)+256);
    this.store.db.prepare("UPDATE conversations SET updated_at=?,json=json_set(json,'$.scope',json(?),'$.bytes',coalesce(json_extract(json,'$.bytes'),0)+?,'$.turnCount',coalesce(json_extract(json,'$.turnCount'),0)+1,'$.status',?,'$.revision',coalesce(json_extract(json,'$.revision'),0)+1) WHERE id=?").run(now,JSON.stringify(message.scope),growth,message.status,conversationId);
    this.store.db.prepare('UPDATE conversation_turns SET json=? WHERE id=?').run(json,message.id);
    inheritRetiredConversationRoots(this.store,conversationId,message);
    this.onTurnReceived?.(message.id,conversationId);
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
    const id=previous?.id??randomUUID(),title=previous?.title??Array.from(question).slice(0,80).join('');
    return this.transaction(()=>{
      const existing=this.store.db.prepare('SELECT json,updated_at FROM conversations WHERE id=?').get(id) as {json:string;updated_at:string}|undefined;
      const meta=existing?JSON.parse(String(existing.json)) as {turnCount?:number;bytes?:number;revision?:number}:undefined;
      if(previous&&(!meta||meta.turnCount!==previous.turnCount||meta.revision!==previous.revision||existing!.updated_at!==previous.updatedAt))throw new StoreError('Conversation changed during this answer; reload and retry',409);
      const count=meta?.turnCount??0,seq=this.nextSeq(id),stored={...turn,seq} as ConversationTurn,json=JSON.stringify(stored),size=Buffer.byteLength(json);
      this.store.reserveMetadata(size+512);
      this.store.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,json=excluded.json').run(id,title,previous?.createdAt??now,now,JSON.stringify({scope:stored.scope,turnCount:count+1,status:stored.status,bytes:(meta?.bytes??0)+size,revision:(meta?.revision??0)+1}));
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
    return {conversationId:conversation.id,revision:conversation.revision??0,turns:active.map(turn=>({id:turn.id,runId:turn.result!.runId})),evidenceDependencies:combineDependencies(active.map(turn=>turn.historyEvidenceDependencies))??{version:1,complete:!active.length,ids:[]}};
  }
  assertHistoryContext(snapshot:NonNullable<QueryInput['historyContext']>){
    const row=this.store.db.prepare("SELECT coalesce(json_extract(json,'$.revision'),0) revision FROM conversations WHERE id=?").get(snapshot.conversationId);
    if(!row||Number(row.revision)!==snapshot.revision)throw new StoreError('Conversation changed; reload its current history',409);
    if(!Array.isArray(snapshot.turns)||new Set(snapshot.turns.map(turn=>turn.id)).size!==snapshot.turns.length)throw new StoreError('Invalid conversation history receipt',409);
    const selected=this.store.db.prepare('SELECT id,json FROM conversation_turns WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?))').all(snapshot.conversationId,JSON.stringify(snapshot.turns.map(turn=>turn.id)));
    const turns=selected.map(value=>JSON.parse(String(value.json)) as ConversationTurn);
    if(turns.length!==snapshot.turns.length||turns.some(turn=>turn.evidenceDeleted||!turn.result||!snapshot.turns.some(pin=>pin.id===turn.id&&pin.runId===turn.result!.runId)))throw new StoreError('Conversation history lineage changed',409);
    const expected=combineDependencies(turns.map(turn=>turn.historyEvidenceDependencies))??{version:1,complete:!turns.length,ids:[]};
    if(snapshot.evidenceDependencies.version!==1||snapshot.evidenceDependencies.complete!==expected.complete||JSON.stringify([...new Set(snapshot.evidenceDependencies.ids)].sort())!==JSON.stringify([...new Set(expected.ids)].sort()))throw new StoreError('Conversation history lineage changed',409);
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
