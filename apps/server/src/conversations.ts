import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store,StoreError} from './store.js';

export type ConversationScope = Pick<QueryInput,'after'|'before'|'deviceId'|'timeZone'>;
export type ConversationTurn = {id:string;question:string;scope:ConversationScope;result?:QueryResult;status:'completed'|'failed';error?:{code:string;message:string};createdAt:string;evidenceDeleted?:boolean};
export type ConversationSummary = {id:string;title:string;createdAt:string;updatedAt:string;turnCount:number;scope:ConversationScope;status:'completed'|'failed'};
export type Conversation = ConversationSummary & {turns:ConversationTurn[]};
type Row = {id:string;title:string;created_at:string;updated_at:string;json:string};
type Failure = {code:string;message:string};

/** Owner-only conversations share the vault's private SQLite backup and quota. */
export class Conversations {
  constructor(private readonly store:Store) {}

  list({limit=50,cursor}:{limit?:number;cursor?:string}={}) {
    let where='';const values:(string|number)[]=[];
    if(cursor) {
      try {
        const value=JSON.parse(Buffer.from(cursor,'base64url').toString()) as {at?:unknown;id?:unknown};
        if(typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at))||typeof value.id!=='string'||value.id.length!==36)throw Error();
        where='WHERE (updated_at < ? OR (updated_at = ? AND id < ?))';values.push(value.at,value.at,value.id);
      }catch{throw new StoreError('Invalid conversation cursor');}
    }
    const rows=this.store.db.prepare(`SELECT id,title,created_at,updated_at,json_extract(json,'$.scope') AS scope,json_array_length(json,'$.turns') AS turn_count,json_extract(json,'$.turns[#-1].status') AS last_turn_status FROM conversations ${where} ORDER BY updated_at DESC,id DESC LIMIT ?`).all(...values,limit+1) as {id:string;title:string;created_at:string;updated_at:string;scope:string;turn_count:number;last_turn_status:string|null}[];
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page.map(row=>({id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:JSON.parse(row.scope),turnCount:row.turn_count,status:row.last_turn_status==='failed'?'failed':'completed'}) as ConversationSummary),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.updated_at,id:last.id})).toString('base64url'):null};
  }

  get(id:string):Conversation {
    const row=this.store.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new StoreError('Conversation not found',404);
    const value=JSON.parse(row.json) as {scope:ConversationScope;turns:Array<Omit<ConversationTurn,'status'> & {status?:ConversationTurn['status']}>};
    const turns=value.turns.map(turn=>({...turn,status:turn.status??(turn.result?'completed':'failed')}));
    return {id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:value.scope,turnCount:turns.length,status:turns.at(-1)?.status??'completed',turns};
  }

  append(previous:Conversation|undefined,input:ConversationScope&{question:string},result:QueryResult) {
    const {question,...scope}=input,now=new Date().toISOString();
    const turn:ConversationTurn={id:randomUUID(),question,scope,result,status:'completed',createdAt:now};
    return this.write(previous,turn);
  }

  appendFailure(previous:Conversation|undefined,input:ConversationScope&{question:string},error:Failure) {
    const {question,...scope}=input,now=new Date().toISOString();
    const turn:ConversationTurn={id:randomUUID(),question,scope,status:'failed',error,createdAt:now};
    return this.write(previous,turn);
  }

  private write(previous:Conversation|undefined,turn:ConversationTurn) {
    const now=turn.createdAt;
    const question=turn.question;
    const id=previous?.id??randomUUID(),title=previous?.title??Array.from(question).slice(0,80).join('');
    const turns=[...(previous?.turns??[]),turn];
    if(turns.length>200)throw new StoreError('Conversation has reached its turn limit; start a new conversation',409);
    const json=JSON.stringify({scope:turn.scope,turns});
    if(Buffer.byteLength(json)>4*1024*1024)throw new StoreError('Conversation has reached its storage limit; start a new conversation',413);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.store.db.prepare('SELECT json FROM conversations WHERE id=?').get(id) as {json:string}|undefined;
      const existingValue=existing?JSON.parse(existing.json) as {scope:ConversationScope;turns:Array<Omit<ConversationTurn,'status'> & {status?:ConversationTurn['status']}>}:undefined;
      const existingTurns=existingValue?.turns.map(value=>({...value,status:value.status??(value.result?'completed':'failed')}));
      if(previous&&(!existingValue||JSON.stringify({scope:previous.scope,turns:previous.turns})!==JSON.stringify({scope:existingValue.scope,turns:existingTurns})))throw new StoreError('Conversation changed during this answer; reload and retry',409);
      this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(existing?.json??'')));
      this.store.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,json=excluded.json').run(id,title,previous?.createdAt??now,now,json);
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    return {conversationId:id,turnId:turn.id};
  }

  delete(id:string) {
    // Public status messages can contain derived facts; remove them with the dialogue.
    if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='query_runs'").get())this.store.db.prepare("DELETE FROM query_runs WHERE json_extract(json,'$.conversationId')=?").run(id);
    return {deleted:Number(this.store.db.prepare('DELETE FROM conversations WHERE id=?').run(id).changes)};
  }

  context(conversation:Conversation,maxTurns=20,maxCharacters=60000):NonNullable<QueryInput['conversation']> {
    const turns:NonNullable<QueryInput['conversation']>['turns']=[];
    let length=0;
    const completedTurns=conversation.turns.filter(turn=>turn.status!=='failed'&&turn.result).length;
    for(const turn of [...conversation.turns].reverse()) {
      if(turn.status==='failed'||!turn.result)continue;

      const answer=turn.result.answer.slice(0,20000);
      const value={question:turn.question,answer,scope:turn.scope,createdAt:turn.createdAt,...(answer.length<turn.result.answer.length?{answerTruncated:true}:{}),...(turn.evidenceDeleted?{evidenceDeleted:true}:{})};
      const size=JSON.stringify(value).length;
      if(turns.length===maxTurns||length+size>maxCharacters)break;
      turns.unshift(value);length+=size;
    }
    return {turns,omittedTurns:completedTurns-turns.length};
  }
}
