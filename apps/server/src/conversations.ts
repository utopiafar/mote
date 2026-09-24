import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store,StoreError} from './store.js';
import {combineDependencies,resolveDependencies} from './conversation-lineage.js';

export type ConversationScope = Pick<QueryInput,'after'|'before'|'deviceId'|'timeZone'>;
export type ConversationTurn = {id:string;question:string;scope:ConversationScope;result?:QueryResult;status:'completed'|'failed';error?:{code:string;message:string};createdAt:string;evidenceDeleted?:boolean;attachments?:{id:string;name:string;mimeType:string}[]};
export type ConversationSummary = {id:string;title:string;createdAt:string;updatedAt:string;turnCount:number;scope:ConversationScope;status:'completed'|'failed'};
export type Conversation = ConversationSummary & {turns:ConversationTurn[];revision?:number};
type Row = {id:string;title:string;created_at:string;updated_at:string;json:string};
type Failure = {code:string;message:string};

/** Owner-only conversations share the vault's private SQLite backup and quota. */
export class Conversations {
  constructor(private readonly store:Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS conversation_turns(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,idx INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,json TEXT NOT NULL,PRIMARY KEY(conversation_id,idx));`);
    if(!store.db.prepare("SELECT 1 FROM settings WHERE key='conversation-turns-v1'").get()){
      store.db.exec('BEGIN IMMEDIATE');try{
        for(const row of store.db.prepare('SELECT id,json FROM conversations').iterate()){
          const value=JSON.parse(String(row.json)),turns=value.turns??[];
          for(const [index,turn] of turns.entries())store.db.prepare('INSERT OR IGNORE INTO conversation_turns VALUES(?,?,?,?)').run(row.id,index,turn.id,JSON.stringify({...turn,status:turn.status??(turn.result?'completed':'failed')}));
          store.db.prepare('UPDATE conversations SET json=? WHERE id=?').run(JSON.stringify({scope:value.scope,turnCount:turns.length,status:turns.at(-1)?.status??'completed',bytes:Buffer.byteLength(JSON.stringify(turns)),revision:1}),row.id);
        }
        store.db.exec("INSERT INTO settings VALUES('conversation-turns-v1','1'); COMMIT");
      }catch(error){store.db.exec('ROLLBACK');throw error;}
    }
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
    return {items:page.map(row=>({id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:JSON.parse(row.scope),turnCount:row.turn_count,status:row.last_turn_status==='failed'?'failed':'completed'}) as ConversationSummary),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.updated_at,id:last.id})).toString('base64url'):null};
  }

  get(id:string):Conversation {return this.read(id);}
  /** UI reads only the requested page. Cursor is the exclusive older turn index. */
  page(id:string,{limit=20,cursor}:{limit?:number;cursor?:string}={}){
    if(cursor!==undefined&&!/^\d{1,9}$/.test(cursor))throw new StoreError('Invalid turn cursor');
    const value=this.read(id,Math.max(1,Math.min(limit,50)),cursor===undefined?undefined:Number(cursor));
    const oldest=(value as Conversation&{firstIndex?:number}).firstIndex??0;
    return {...value,nextCursor:oldest>0?String(oldest):null};
  }
  private read(id:string,limit=200,before?:number):Conversation&{firstIndex:number} {
    const row=this.store.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new StoreError('Conversation not found',404);
    const value=JSON.parse(row.json);
    const rows=this.store.db.prepare('SELECT idx,json FROM conversation_turns WHERE conversation_id=? AND idx<? ORDER BY idx DESC LIMIT ?').all(id,before??value.turnCount,limit).reverse();
    const turns=rows.map(r=>JSON.parse(String(r.json)) as ConversationTurn);
    return {id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,scope:value.scope,turnCount:value.turnCount,status:value.status,revision:value.revision,turns,firstIndex:Number(rows[0]?.idx??0)};
  }

  append(previous:Conversation|undefined,input:ConversationScope&{question:string;attachments?:{id:string;name:string;mimeType:string}[]},result:QueryResult) {
    const {question,attachments,...scope}=input,now=new Date().toISOString();
    const evidenceDependencies=resolveDependencies(this.store,result.evidenceDependencies);
    const turn:ConversationTurn={id:randomUUID(),question,scope,result:{...result,...(evidenceDependencies?{evidenceDependencies}:{})},status:'completed',createdAt:now,...(attachments?.length?{attachments}:{})};
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
    const json=JSON.stringify(turn),size=Buffer.byteLength(json);
    const own=!this.store.db.isTransaction;if(own)this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const existing=this.store.db.prepare('SELECT json,updated_at FROM conversations WHERE id=?').get(id);
      const meta=existing?JSON.parse(String(existing.json)):undefined;
      if(previous&&(!meta||meta.turnCount!==previous.turnCount||meta.revision!==previous.revision||existing!.updated_at!==previous.updatedAt))throw new StoreError('Conversation changed during this answer; reload and retry',409);
      const count=meta?.turnCount??0;
      if(count>=200)throw new StoreError('Conversation has reached its turn limit; start a new conversation',409);
      if((meta?.bytes??0)+size>4*1024*1024)throw new StoreError('Conversation has reached its storage limit; start a new conversation',413);
      this.store.reserveMetadata(size+512);
      this.store.db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,json=excluded.json').run(id,title,previous?.createdAt??now,now,JSON.stringify({scope:turn.scope,turnCount:count+1,status:turn.status,bytes:(meta?.bytes??0)+size,revision:(meta?.revision??0)+1}));
      this.store.db.prepare('INSERT INTO conversation_turns VALUES(?,?,?,?)').run(id,count,turn.id,json);
      if(own)this.store.db.exec('COMMIT');
    }catch(error){if(own&&this.store.db.isTransaction)this.store.db.exec('ROLLBACK');throw error;}
    return {conversationId:id,turnId:turn.id};
  }

  delete(id:string) {
    // Public status messages can contain derived facts; remove them with the dialogue.
    if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='query_runs'").get())this.store.db.prepare("DELETE FROM query_runs WHERE json_extract(json,'$.conversationId')=?").run(id);
    return {deleted:Number(this.store.db.prepare('DELETE FROM conversations WHERE id=?').run(id).changes)};
  }

  context(conversation:Conversation,maxTurns=20,maxCharacters=60000):NonNullable<QueryInput['conversation']> {
    const turns:NonNullable<QueryInput['conversation']>['turns']=[];
    const dependencies:QueryResult['evidenceDependencies'][]=[];
    let length=0;
    const completedTurns=conversation.turns.filter(turn=>turn.status!=='failed'&&turn.result).length;
    for(const turn of [...conversation.turns].reverse()) {
      if(turn.status==='failed'||!turn.result)continue;

      const answer=turn.result.answer.slice(0,20000);
      const value={question:turn.question,answer,scope:turn.scope,createdAt:turn.createdAt,...(answer.length<turn.result.answer.length?{answerTruncated:true}:{}),...(turn.evidenceDeleted?{evidenceDeleted:true}:{}),...(turn.attachments?.length?{attachments:turn.attachments}:{})};
      const size=JSON.stringify(value).length;
      if(turns.length===maxTurns||length+size>maxCharacters)break;
      turns.unshift(value);length+=size;
      dependencies.push(turn.evidenceDeleted?{version:1,complete:true,ids:[]}:turn.result.evidenceDependencies);
    }
    const evidenceDependencies=combineDependencies(dependencies);
    return {turns,omittedTurns:completedTurns-turns.length,...(evidenceDependencies?{evidenceDependencies}:{})};
  }
}
