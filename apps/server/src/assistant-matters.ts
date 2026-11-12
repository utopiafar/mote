import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {queryScopeSchema,type OperationState,type QueryScope} from '@mote/shared';
import {z} from 'zod';
import {decodeMemoryPrivate,encodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {StoreError,sha256,type Store} from './store.js';

/** Owner-authored assistant matters. A matter stores a goal, the scope the
 * owner selected, its lifecycle state and links to existing work/evidence. It
 * never copies Memory, Todos, Actions or evidence bodies. */
export const matterStateSchema=z.enum(['active','paused','archived']);
export type MatterState=z.infer<typeof matterStateSchema>;

const MAX_SAFE=Number.MAX_SAFE_INTEGER;
const uuid=z.string().uuid();
const revision=z.number().int().positive().max(MAX_SAFE);
const timestamp=z.string().datetime({offset:true});
const ownerText=z.string().min(1).max(8000).refine(value=>value.trim().length>0,{message:'Input cannot be blank'});
const correctionText=z.string().min(1).max(4000).refine(value=>value.trim().length>0,{message:'Correction cannot be blank'});
const linkIds=z.array(uuid).max(100).refine(ids=>new Set(ids).size===ids.length,{message:'Linked IDs must be unique'}).transform(ids=>[...ids].sort());

export const matterSchema=z.object({
  id:uuid,goal:ownerText,scope:queryScopeSchema,state:matterStateSchema,revision,
  taskIds:linkIds,evidenceIds:linkIds,correction:correctionText.nullable(),
  createdAt:timestamp,updatedAt:timestamp,archivedAt:timestamp.nullable(),
}).strict().superRefine((value,context)=>{
  if((value.state==='archived')!==(value.archivedAt!==null))
    context.addIssue({code:z.ZodIssueCode.custom,message:'Archived state and time must agree'});
});
export type Matter=z.infer<typeof matterSchema>;

export const matterRevisionSchema=z.object({
  matterId:uuid,revision,command:z.enum(['create','edit','pause','resume','archive']),
  recordedAt:timestamp,state:matterStateSchema,goal:ownerText,scope:queryScopeSchema,
  taskIds:linkIds,evidenceIds:linkIds,correction:correctionText.nullable(),
}).strict();
export type MatterRevision=z.infer<typeof matterRevisionSchema>;

const matterPayloadSchema=z.object({
  goal:ownerText,scope:queryScopeSchema,taskIds:linkIds,evidenceIds:linkIds,correction:correctionText.nullable(),
}).strict();
type MatterPayload=z.infer<typeof matterPayloadSchema>;

const createFields={goal:ownerText,scope:queryScopeSchema,taskIds:linkIds.default([]),evidenceIds:linkIds.default([]),correction:correctionText.nullable().default(null)};
const editFields={goal:ownerText.optional(),scope:queryScopeSchema.optional(),taskIds:linkIds.optional(),evidenceIds:linkIds.optional(),correction:correctionText.nullable().optional()};
const transitionFields={matterId:uuid,expectedRevision:revision,correction:correctionText.optional()};

/** A model may propose these typed commands; only the host executes them.
 * Unknown fields, arbitrary states and edits that change nothing are refused. */
export const matterCommandSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('create'),requestId:uuid,...createFields}).strict(),
  z.object({type:z.literal('edit'),matterId:uuid,expectedRevision:revision,...editFields}).strict(),
  z.object({type:z.literal('pause'),...transitionFields}).strict(),
  z.object({type:z.literal('resume'),...transitionFields}).strict(),
  z.object({type:z.literal('archive'),...transitionFields}).strict(),
]).superRefine((value,context)=>{
  if(value.type==='edit'&&value.goal===undefined&&value.scope===undefined&&value.taskIds===undefined&&
    value.evidenceIds===undefined&&value.correction===undefined)
    context.addIssue({code:z.ZodIssueCode.custom,message:'An edit requires at least one change'});
});
export type MatterCommand=z.infer<typeof matterCommandSchema>;

/** Current readable evidence for the caller's request. The saved matter scope
 * is never passed here as authorization: callers build this from the live
 * request/source grants, and omitted IDs are treated as unavailable. */
export type MatterEvidenceView={id:string;title:string;sourceId?:string;deviceId?:string;at:string};
/** Current task metadata. A stale task may be returned so the matter can show
 * that its link expired; an unavailable task is omitted. */
export type MatterTaskView={id:string;state:OperationState;revision:number;updatedAt:string};
export type MatterAuthority={
  currentEvidence(ids:readonly string[]):readonly MatterEvidenceView[];
  currentTask(id:string):MatterTaskView|undefined;
};
export type MatterCoverage='complete'|'partial';
/** `matter.taskIds`/`evidenceIds` are saved owner configuration. Render
 * `linkedTasks`/`linkedEvidence` for current disclosure; the raw link IDs are
 * not a claim that the linked item is still readable. */
export type MatterDetail={
  matter:Matter;linkedTasks:MatterTaskView[];linkedEvidence:MatterEvidenceView[];
  coverage:{tasks:MatterCoverage;evidence:MatterCoverage};
};

type MatterRow={id:string;created_at:string;updated_at:string;archived_at:string|null;state:MatterState;revision:number;request_id:string;request_hash:string;json:string};
type RevisionRow={matter_id:string;revision:number;recorded_at:string;command:MatterRevision['command'];state:MatterState;json:string};

/** Deterministic saved-scope filter. Scope is a selection the owner saved for
 * future work, not a permission grant; currentEvidence() has already applied
 * the live authorization before this runs. */
export function matterScopeContains(scope:QueryScope,evidence:MatterEvidenceView){
  if(scope.deviceId!==undefined&&evidence.deviceId!==scope.deviceId)return false;
  if(scope.kind==='selection'&&scope.sourceIds!==undefined&&
    (evidence.sourceId===undefined||!scope.sourceIds.includes(evidence.sourceId)))return false;
  if(scope.evidenceIds!==undefined&&!scope.evidenceIds.includes(evidence.id))return false;
  const at=Date.parse(evidence.at);
  if(!Number.isFinite(at))return false;
  if(scope.after!==undefined&&at<Date.parse(scope.after))return false;
  if(scope.before!==undefined&&at>=Date.parse(scope.before))return false;
  return true;
}

export function installAssistantMatters(store:Store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_matters(
    id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,
    state TEXT NOT NULL,revision INTEGER NOT NULL,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS assistant_matters_page ON assistant_matters(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS assistant_matters_state ON assistant_matters(state,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS assistant_matter_revisions(
      matter_id TEXT NOT NULL REFERENCES assistant_matters(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,recorded_at TEXT NOT NULL,command TEXT NOT NULL,state TEXT NOT NULL,json TEXT NOT NULL,
      PRIMARY KEY(matter_id,revision));`);
  store.registerStorage('assistant-matters',{
    assistant_matters:'length(CAST(id AS BLOB))+length(CAST(request_id AS BLOB))+length(CAST(request_hash AS BLOB))+coalesce(length(CAST(json AS BLOB)),0)+256',
    assistant_matter_revisions:'length(CAST(matter_id AS BLOB))+coalesce(length(CAST(json AS BLOB)),0)+128',
  });
}

/** Durable matters with revision-checked typed commands. Read projections take
 * a fresh authority on every call, so an old scope snapshot never authorizes
 * disclosure or a new link. */
export class AssistantMatters {
  constructor(private readonly store:Store,private readonly now=()=>new Date().toISOString()){installAssistantMatters(store);}

  private transaction<T>(run:()=>T):T{
    const db=this.store.db;db.exec('SAVEPOINT assistant_matters_write');
    try{const value=run();db.exec('RELEASE assistant_matters_write');return value;}
    catch(error){db.exec('ROLLBACK TO assistant_matters_write; RELEASE assistant_matters_write');throw error;}
  }
  private row(id:string):MatterRow{
    const row=this.store.db.prepare('SELECT * FROM assistant_matters WHERE id=?').get(id) as MatterRow|undefined;
    if(!row)throw new StoreError('Matter not found',404);
    return row;
  }
  private current(id:string,expectedRevision:number):MatterRow{
    const row=this.row(id);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||row.revision!==expectedRevision)
      throw new StoreError('Matter changed; reload before continuing',409);
    return row;
  }
  private payload(row:MatterRow):MatterPayload{
    let decoded:unknown;
    try{decoded=decodeMemoryPrivate(this.store,row.json);}catch{throw new StoreError('Stored matter is unavailable',409);}
    const parsed=matterPayloadSchema.safeParse(decoded);
    if(!parsed.success)throw new StoreError('Stored matter is unavailable',409);
    return parsed.data;
  }
  private encode(payload:MatterPayload){return encodeMemoryPrivate(this.store,matterPayloadSchema.parse(payload));}
  private matter(row:MatterRow):Matter{
    const parsed=matterSchema.safeParse({...this.payload(row),id:row.id,state:row.state,revision:row.revision,
      createdAt:row.created_at,updatedAt:row.updated_at,archivedAt:row.archived_at});
    if(!parsed.success)throw new StoreError('Stored matter is unavailable',409);
    return parsed.data;
  }
  private revision(row:RevisionRow):MatterRevision{
    let decoded:unknown;
    try{decoded=decodeMemoryPrivate(this.store,row.json);}catch{throw new StoreError('Stored matter history is unavailable',409);}
    const payload=matterPayloadSchema.safeParse(decoded);
    if(!payload.success)throw new StoreError('Stored matter history is unavailable',409);
    const parsed=matterRevisionSchema.safeParse({...payload.data,matterId:row.matter_id,revision:row.revision,
      command:row.command,recordedAt:row.recorded_at,state:row.state});
    if(!parsed.success)throw new StoreError('Stored matter history is unavailable',409);
    return parsed.data;
  }
  private insertRevision(id:string,revision:number,command:MatterRevision['command'],state:MatterState,payload:MatterPayload,at:string){
    this.store.db.prepare('INSERT INTO assistant_matter_revisions VALUES(?,?,?,?,?,?)')
      .run(id,revision,at,command,state,this.encode(payload));
  }
  private checkLinks(payload:MatterPayload,authority:MatterAuthority){
    const evidence=new Map(authority.currentEvidence(payload.evidenceIds).map(item=>[item.id,item]));
    for(const id of payload.evidenceIds){
      const item=evidence.get(id);
      if(!item)throw new StoreError('Matter evidence link is not currently readable',409);
      if(!matterScopeContains(payload.scope,item))throw new StoreError('Matter evidence link is outside the saved scope',409);
    }
    for(const id of payload.taskIds){
      const task=authority.currentTask(id);
      if(!task)throw new StoreError('Matter task link is not currently readable',409);
      if(task.state==='stale')throw new StoreError('Matter task link is stale',409);
    }
  }

  get(id:string):Matter{return this.matter(this.row(id));}

  /** Stable creation ordering: status edits do not move matters across pages. */
  page(args:{state?:MatterState;limit?:number;cursor?:string}={}){
    const selected=z.object({state:matterStateSchema.optional(),limit:z.number().int().min(1).max(100).default(30),
      cursor:z.string().max(1000).optional()}).strict().parse(args);
    const where:string[]=[],values:(string|number)[]=[];
    if(selected.state!==undefined){where.push('state=?');values.push(selected.state);}
    if(selected.cursor){
      let cursor:{at:string;id:string};
      try{cursor=z.object({at:timestamp,id:uuid}).strict().parse(JSON.parse(Buffer.from(selected.cursor,'base64url').toString()));}
      catch{throw new StoreError('Invalid matter cursor');}
      where.push('(created_at<? OR (created_at=? AND id<?))');values.push(cursor.at,cursor.at,cursor.id);
    }
    const rows=this.store.db.prepare(`SELECT * FROM assistant_matters ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...values,selected.limit+1) as MatterRow[],items=rows.slice(0,selected.limit).map(row=>this.matter(row)),last=items.at(-1);
    return {items,nextCursor:rows.length>selected.limit&&last?Buffer.from(JSON.stringify({at:last.createdAt,id:last.id})).toString('base64url'):null};
  }

  /** Archived matters keep their legal history; the history is not a second
   * source of evidence and contains only owner-authored fields and link IDs. */
  history(id:string):MatterRevision[]{
    this.row(id);
    return (this.store.db.prepare('SELECT * FROM assistant_matter_revisions WHERE matter_id=? ORDER BY revision').all(id) as RevisionRow[]).map(row=>this.revision(row));
  }

  /** Resolve links through current authority and the saved selection. Deleted
   * or revoked evidence disappears with its title; no stored body can leak. */
  detail(id:string,authority:MatterAuthority):MatterDetail{
    const matter=this.get(id);
    const tasks=matter.taskIds.flatMap(id=>{
      const task=authority.currentTask(id);
      return task?[{id:task.id,state:task.state,revision:task.revision,updatedAt:task.updatedAt}]:[];
    });
    const current=new Map(authority.currentEvidence(matter.evidenceIds).map(item=>[item.id,item]));
    const linkedEvidence=matter.evidenceIds.flatMap(id=>{
      const item=current.get(id);
      return item&&matterScopeContains(matter.scope,item)?[{...item,title:item.title.slice(0,300)}]:[];
    });
    return {matter,linkedTasks:tasks,linkedEvidence,
      coverage:{tasks:tasks.length===matter.taskIds.length?'complete':'partial',evidence:linkedEvidence.length===matter.evidenceIds.length?'complete':'partial'}};
  }

  /** A paused or archived matter admits no new automatic work. Existing tasks
   * keep their own lifecycle; this service never cancels or rewrites them. */
  automaticWorkAllowed(id:string){return this.get(id).state==='active';}
  assertAutomaticWorkAllowed(id:string){
    const matter=this.get(id);
    if(matter.state!=='active')throw new StoreError(`Matter is ${matter.state}; new automatic work is not admitted`,409);
    return matter;
  }

  /** One typed product command. Model text cannot write state directly. */
  command(raw:unknown,authority:MatterAuthority):Matter{
    const command=matterCommandSchema.parse(raw);
    if(command.type==='create')return this.create(command,authority);
    if(command.type==='edit')return this.edit(command,authority);
    return this.transition(command);
  }

  private create(command:Extract<MatterCommand,{type:'create'}>,authority:MatterAuthority):Matter{
    const payload=matterPayloadSchema.parse({goal:command.goal,scope:command.scope,
      taskIds:command.taskIds,evidenceIds:command.evidenceIds,correction:command.correction});
    const hash=sha256(JSON.stringify({type:'create',...payload}));
    return this.transaction(()=>{
      const prior=this.store.db.prepare('SELECT * FROM assistant_matters WHERE request_id=?').get(command.requestId) as MatterRow|undefined;
      if(prior){if(prior.request_hash!==hash)throw new StoreError('Matter request ID was reused with different content',409);return this.matter(prior);}
      this.checkLinks(payload,authority);
      const id=randomUUID(),at=this.now();
      this.store.db.prepare('INSERT INTO assistant_matters VALUES(?,?,?,NULL,?,?,?,?,?)')
        .run(id,at,at,'active',1,command.requestId,hash,this.encode(payload));
      this.insertRevision(id,1,'create','active',payload,at);
      // Meter the actual inserted rows so quota failures roll back both rows.
      this.store.reserveMetadata(0);
      return this.get(id);
    });
  }

  private edit(command:Extract<MatterCommand,{type:'edit'}>,authority:MatterAuthority):Matter{
    return this.transaction(()=>{
      const row=this.current(command.matterId,command.expectedRevision);
      if(row.state==='archived')throw new StoreError('Archived matters cannot be edited',409);
      const current=this.payload(row);
      const payload=matterPayloadSchema.parse({...current,
        ...(command.goal!==undefined?{goal:command.goal}:{}),
        ...(command.scope!==undefined?{scope:command.scope}:{}),
        ...(command.taskIds!==undefined?{taskIds:command.taskIds}:{}),
        ...(command.evidenceIds!==undefined?{evidenceIds:command.evidenceIds}:{}),
        ...(command.correction!==undefined?{correction:command.correction}:{})});
      if(command.scope!==undefined||command.taskIds!==undefined||command.evidenceIds!==undefined)this.checkLinks(payload,authority);
      // A typed edit must change an actual value, not merely repeat one. This
      // keeps no-op saves from consuming a revision and causing false conflicts.
      if(isDeepStrictEqual(payload,current))throw new StoreError('Matter edit did not change any field');
      const at=this.now(),nextRevision=row.revision+1;
      const changed=this.store.db.prepare('UPDATE assistant_matters SET json=?,revision=?,updated_at=? WHERE id=? AND revision=?')
        .run(this.encode(payload),nextRevision,at,command.matterId,row.revision);
      if(!changed.changes)throw new StoreError('Matter changed; reload before continuing',409);
      this.insertRevision(command.matterId,nextRevision,'edit',row.state,payload,at);
      this.store.reserveMetadata(0);
      return this.get(command.matterId);
    });
  }

  private transition(command:Extract<MatterCommand,{type:'pause'|'resume'|'archive'}>):Matter{
    return this.transaction(()=>{
      const row=this.current(command.matterId,command.expectedRevision);
      if(row.state==='archived')throw new StoreError('Archived matters cannot change state',409);
      if(command.type==='pause'&&row.state!=='active')throw new StoreError('Only an active matter can be paused',409);
      if(command.type==='resume'&&row.state!=='paused')throw new StoreError('Only a paused matter can be resumed',409);
      const state:MatterState=command.type==='pause'?'paused':command.type==='resume'?'active':'archived';
      const at=this.now(),nextRevision=row.revision+1;
      const current=this.payload(row),payload=matterPayloadSchema.parse({...current,
        ...(command.correction!==undefined?{correction:command.correction}:{})});
      const changed=this.store.db.prepare('UPDATE assistant_matters SET json=?,state=?,revision=?,updated_at=?,archived_at=? WHERE id=? AND revision=?')
        .run(this.encode(payload),state,nextRevision,at,state==='archived'?at:row.archived_at,command.matterId,row.revision);
      if(!changed.changes)throw new StoreError('Matter changed; reload before continuing',409);
      this.insertRevision(command.matterId,nextRevision,command.type,state,payload,at);
      this.store.reserveMetadata(0);
      return this.get(command.matterId);
    });
  }
}
