import {randomUUID} from 'node:crypto';
import {queryScopeSchema,sourceIdSchema,type QueryScope,type Routine} from '@mote/shared';
import {z} from 'zod';
import {BackgroundModelAuthorization,routineModelIdentity} from './background-model-authorization.js';
import {decodeMemoryPrivate,encodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {nextRoutineOccurrence,routineScheduleSchema,type RoutineCalendarEvent,type RoutineSchedule} from './routines-time.js';
import {sha256,StoreError,type Store} from './store.js';

const eventRefSchema=z.object({sourceId:sourceIdSchema,externalId:z.string().min(1).max(1000)}).strict();
const payloadSchema=z.object({goal:z.string().min(1).max(7600).refine(value=>Boolean(value.trim())),scope:queryScopeSchema,
 schedule:routineScheduleSchema,matterId:z.string().uuid().nullable(),event:eventRefSchema.nullable()}).strict().superRefine((value,ctx)=>{
 if((value.schedule.trigger.kind==='before-event')!==(value.event!==null))ctx.addIssue({code:z.ZodIssueCode.custom,message:'A before-event rule requires one current calendar source'});
});
type Payload=z.infer<typeof payloadSchema>;
export type RoutineRef={ruleId:string;revision:number;scheduledAt:string};
export type RoutineInput={requestId:string;goal:string;scope:QueryScope;routine:RoutineRef;coverage:{from:string;through:string};receipt:string};
type Row={id:string;revision:number;enabled:number;next_due:string|null;event_revision:string|null;json:string;request_hash:string};
type OccurrenceRow={rule_id:string;revision:number;scheduled_at:string;first_due:string;event_revision:string|null;request_id:string;receipt:string;task_id:string|null};
type EventResolver=(ref:z.infer<typeof eventRefSchema>,scope:QueryScope)=>RoutineCalendarEvent|undefined;

/** Owner-configured routine state and occurrence admission. This is a domain
 * consumer of the existing poll and batch executor, not a scheduler or grant. */
export class AssistantRoutines {
 constructor(private readonly store:Store,private readonly control:BackgroundModelAuthorization,
  private readonly startTask:(ref:RoutineRef)=>{id:string},private readonly event:EventResolver,
  private readonly matterActive:(id:string,scope:QueryScope)=>boolean,private readonly now=Date.now){
  store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_routines(
   id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,revision INTEGER NOT NULL,
   enabled INTEGER NOT NULL,next_due TEXT,event_revision TEXT,json TEXT NOT NULL,event_rule INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS assistant_routines_due ON assistant_routines(enabled,next_due);
   CREATE TABLE IF NOT EXISTS assistant_routine_occurrences(
   rule_id TEXT NOT NULL REFERENCES assistant_routines(id),revision INTEGER NOT NULL,scheduled_at TEXT NOT NULL,first_due TEXT NOT NULL,
   event_revision TEXT,request_id TEXT NOT NULL UNIQUE,receipt TEXT NOT NULL UNIQUE,task_id TEXT REFERENCES task_records(id),
   PRIMARY KEY(rule_id,revision,scheduled_at),UNIQUE(rule_id,revision,first_due));`);
  store.registerStorage('assistant-routines',{
   assistant_routines:'length(CAST(id AS BLOB))+length(CAST(request_id AS BLOB))+length(CAST(request_hash AS BLOB))+length(CAST(json AS BLOB))+256',
   assistant_routine_occurrences:'length(CAST(rule_id AS BLOB))+length(CAST(receipt AS BLOB))+256',
  });
 }
 private transaction<T>(write:()=>T):T{
  const db=this.store.db,own=!db.isTransaction;
  if(own)db.exec('BEGIN IMMEDIATE');else db.exec('SAVEPOINT assistant_routine_write');
  try{const result=write();db.exec(own?'COMMIT':'RELEASE assistant_routine_write');return result;}
  catch(error){if(own){if(db.isTransaction)db.exec('ROLLBACK');}else db.exec('ROLLBACK TO assistant_routine_write; RELEASE assistant_routine_write');throw error;}
 }
 private row(id:string):Row{
  const row=this.store.db.prepare('SELECT * FROM assistant_routines WHERE id=?').get(id) as Row|undefined;
  if(!row)throw new StoreError('Routine not found',404);return row;
 }
 private payload(row:Row):Payload{return payloadSchema.parse(decodeMemoryPrivate(this.store,row.json));}
 private calendar(payload:Payload){return payload.event?this.event(payload.event,payload.scope):undefined;}
 private next(payload:Payload,at:number){
  const event=this.calendar(payload);if(payload.event&&!event)return null;
  return nextRoutineOccurrence(payload.schedule,new Date(at),event);
 }
 private view(row:Row):Routine{return {id:row.id,revision:row.revision,enabled:Boolean(row.enabled),nextDue:row.next_due,...this.payload(row)};}
 get(id:string){return this.view(this.row(id));}
 /** Stable owner browsing; changing or pausing a rule does not reorder it. */
 page(args:{limit?:number;cursor?:string}={}){
  const input=z.object({limit:z.number().int().min(1).max(100).default(30),cursor:z.string().uuid().optional()}).strict().parse(args);
  const rows=this.store.db.prepare('SELECT * FROM assistant_routines WHERE id>? ORDER BY id LIMIT ?').all(input.cursor??'',input.limit+1) as Row[];
  const items=rows.slice(0,input.limit).map(row=>this.view(row));
  return {items,nextCursor:rows.length>input.limit?items.at(-1)!.id:null};
 }
 /** Called only from an owner product command, never from a query tool. */
 create(raw:unknown){
  const input=z.object({requestId:z.string().uuid(),goal:payloadSchema.innerType().shape.goal,scope:queryScopeSchema,
   timeZone:routineScheduleSchema.shape.timeZone,trigger:routineScheduleSchema.shape.trigger,
   matterId:z.string().uuid().nullable().default(null),event:eventRefSchema.nullable().default(null)}).strict().parse(raw);
  const payload=payloadSchema.parse({goal:input.goal.trim(),scope:input.scope,schedule:{revision:1,timeZone:input.timeZone,trigger:input.trigger},matterId:input.matterId,event:input.event});
  const hash=sha256(JSON.stringify(payload));
  return this.transaction(()=>{
   const prior=this.store.db.prepare('SELECT * FROM assistant_routines WHERE request_id=?').get(input.requestId) as Row|undefined;
   if(prior){if(prior.request_hash!==hash)throw new StoreError('Routine request ID was reused',409);return this.view(prior);}
   if(payload.matterId&&!this.matterActive(payload.matterId,payload.scope))throw new StoreError('Routine matter is unavailable or paused',409);
   const event=this.calendar(payload);if(payload.event&&!event)throw new StoreError('Routine calendar event is unavailable',409);
   const next=this.next(payload,this.now()),id=randomUUID();
   this.store.db.prepare('INSERT INTO assistant_routines VALUES(?,?,?,1,1,?,?,?,?)').run(id,input.requestId,hash,next?.scheduledAt??null,event?.revision??null,encodeMemoryPrivate(this.store,payload),Number(Boolean(payload.event)));
   this.store.reserveMetadata(0);return this.get(id);
  });
 }
 /** Changing or pausing a rule revokes all of its older occurrences. Resume
  * begins at the next future time rather than replaying the paused interval. */
 update(raw:unknown){
  const input=z.object({ruleId:z.string().uuid(),expectedRevision:z.number().int().positive().safe(),enabled:z.boolean().optional(),
   goal:z.string().min(1).max(7600).optional(),scope:queryScopeSchema.optional(),timeZone:routineScheduleSchema.shape.timeZone.optional(),
   trigger:routineScheduleSchema.shape.trigger.optional(),matterId:z.string().uuid().nullable().optional(),event:eventRefSchema.nullable().optional()}).strict().parse(raw);
  return this.transaction(()=>{
   const row=this.row(input.ruleId);if(row.revision!==input.expectedRevision)throw new StoreError('Routine changed; reload before continuing',409);
   const old=this.payload(row),revision=row.revision+1,enabled=input.enabled??Boolean(row.enabled);
   const payload=payloadSchema.parse({goal:input.goal?.trim()??old.goal,scope:input.scope??old.scope,
    schedule:{revision,timeZone:input.timeZone??old.schedule.timeZone,trigger:input.trigger??old.schedule.trigger},
    matterId:input.matterId===undefined?old.matterId:input.matterId,event:input.event===undefined?old.event:input.event});
   if(enabled&&payload.matterId&&!this.matterActive(payload.matterId,payload.scope))throw new StoreError('Routine matter is unavailable or paused',409);
   const event=enabled?this.calendar(payload):undefined;
   if(enabled&&payload.event&&!event)throw new StoreError('Routine calendar event is unavailable',409);
   const next=enabled?this.next(payload,this.now()):null;
   this.store.db.prepare('UPDATE assistant_routines SET revision=?,enabled=?,next_due=?,event_revision=?,json=?,event_rule=? WHERE id=? AND revision=?')
    .run(revision,Number(enabled),next?.scheduledAt??null,event?.revision??null,encodeMemoryPrivate(this.store,payload),Number(Boolean(payload.event)),row.id,row.revision);
   this.store.reserveMetadata(0);return this.get(row.id);
  });
 }
 private occurrence(ref:RoutineRef):OccurrenceRow|undefined{return this.store.db.prepare('SELECT * FROM assistant_routine_occurrences WHERE rule_id=? AND revision=? AND scheduled_at=?').get(ref.ruleId,ref.revision,ref.scheduledAt) as OccurrenceRow|undefined;}
 /** Checked by the task service before a model send and before publication. */
 current(ref:RoutineRef){
  try{
   const row=this.row(ref.ruleId),occ=this.occurrence(ref);if(!occ||row.revision!==ref.revision||!row.enabled)return false;
   const payload=this.payload(row);if(payload.matterId&&!this.matterActive(payload.matterId,payload.scope))return false;
   if(payload.event){
    const event=this.calendar(payload);if(!event||event.revision!==occ.event_revision||Date.parse(event.calendar.start)<=this.now())return false;
    const due=nextRoutineOccurrence(payload.schedule,new Date(Date.parse(ref.scheduledAt)-1),event);
    if(due?.scheduledAt!==ref.scheduledAt)return false;
   }
   return true;
  }catch{return false;}
 }
 /** The task service obtains frozen owner intent and coverage from the occurrence;
  * callers cannot substitute a source, scope, or goal when minting a receipt. */
 input(ref:RoutineRef):RoutineInput{
  if(!this.store.db.isTransaction||!this.current(ref))throw new StoreError('Routine occurrence is no longer current',409);
  const occ=this.occurrence(ref)!,payload=this.payload(this.row(ref.ruleId));
  return {requestId:occ.request_id,goal:payload.goal,scope:payload.scope,routine:ref,coverage:{from:occ.first_due,through:occ.scheduled_at},receipt:occ.receipt};
 }
 private latest(schedule:RoutineSchedule,first:string,now:number){
  if(schedule.trigger.kind==='before-event')return first;
  // At most a fortnight of candidate instants is enough to find the latest
  // daily/weekly due, irrespective of the length of the outage.
  let latest=first,after=Math.max(Date.parse(first)-1,now-15*86400000);
  for(let i=0;i<20;i++){
   const candidate=nextRoutineOccurrence(schedule,new Date(after));
   if(!candidate||Date.parse(candidate.scheduledAt)>now)break;
   if(Date.parse(candidate.scheduledAt)>=Date.parse(first))latest=candidate.scheduledAt;
   after=Date.parse(candidate.scheduledAt);
  }
  return latest;
 }
 /** The caller supplies the exact observed due value, never a free-form time. */
 admit(raw:unknown){
  const ref=z.object({ruleId:z.string().uuid(),revision:z.number().int().positive().safe(),scheduledAt:z.string().datetime({offset:true})}).strict().parse(raw);
  return this.transaction(()=>{
   const row=this.row(ref.ruleId);if(row.revision!==ref.revision||!row.enabled)throw new StoreError('Routine changed or paused',409);
   const prior=this.store.db.prepare('SELECT task_id FROM assistant_routine_occurrences WHERE rule_id=? AND revision=? AND (first_due=? OR scheduled_at=?)').get(ref.ruleId,ref.revision,ref.scheduledAt,ref.scheduledAt);
   if(prior?.task_id)return {taskId:String(prior.task_id)};
   const now=this.now();if(this.control.view().state!=='on'||row.next_due!==ref.scheduledAt||Date.parse(ref.scheduledAt)>now)throw new StoreError('Routine is not due or background processing is off',409);
   const payload=this.payload(row);if(payload.matterId&&!this.matterActive(payload.matterId,payload.scope))throw new StoreError('Routine matter is unavailable or paused',409);
   const event=this.calendar(payload);
   if(payload.event&&(!event||event.revision!==row.event_revision||Date.parse(event.calendar.start)<=now||
     nextRoutineOccurrence(payload.schedule,new Date(Date.parse(ref.scheduledAt)-1),event)?.scheduledAt!==ref.scheduledAt))throw new StoreError('Routine calendar event changed or expired',409);
   const scheduledAt=this.latest(payload.schedule,ref.scheduledAt,now),actual={...ref,scheduledAt};
   const receipt=routineModelIdentity(ref.ruleId,ref.revision,scheduledAt),requestId=randomUUID();
   this.store.db.prepare('UPDATE assistant_routines SET next_due=? WHERE id=? AND revision=?').run(scheduledAt,row.id,row.revision);
   this.store.db.prepare('INSERT INTO assistant_routine_occurrences VALUES(?,?,?,?,?,?,?,NULL)')
    .run(row.id,row.revision,scheduledAt,ref.scheduledAt,row.event_revision,requestId,receipt);
   this.control.receiveRoutineOccurrence(row.id,row.revision,scheduledAt);
   const task=this.startTask(actual);
   this.store.db.prepare('UPDATE assistant_routine_occurrences SET task_id=? WHERE rule_id=? AND revision=? AND scheduled_at=?').run(task.id,row.id,row.revision,scheduledAt);
   const next=payload.event?null:this.next(payload,now);
   this.store.db.prepare('UPDATE assistant_routines SET next_due=?,event_revision=? WHERE id=? AND revision=?').run(next?.scheduledAt??null,payload.event?event?.revision??null:next?.eventRevision??null,row.id,row.revision);
   this.store.reserveMetadata(0);return {taskId:task.id};
  });
 }
 /** Called on the existing Central poll, including when there are no changes. */
 tick(limit=100){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new StoreError('Invalid routine page');
  if(this.control.view().state!=='on')return 0;
  const now=this.now();
  // Event changes can move a preparation window earlier than its old due time.
  // Refresh every event rule, including already-consumed or unavailable ones.
  for(const row of this.store.db.prepare('SELECT * FROM assistant_routines WHERE enabled=1 AND event_rule=1 ORDER BY id').all() as Row[]){
   const payload=this.payload(row),event=this.calendar(payload),revision=event?.revision??null;
   if(revision===row.event_revision&&(!row.next_due||event&&Date.parse(event.calendar.start)>now))continue;
   let due:string|null=null;
   if(event&&event.calendar.status!=='cancelled'&&Date.parse(event.calendar.start)>now&&payload.schedule.trigger.kind==='before-event'){
    const at=Date.parse(event.calendar.start)-payload.schedule.trigger.leadMinutes*60000;
    due=nextRoutineOccurrence(payload.schedule,new Date(at-1),event)?.scheduledAt??null;
    if(due&&this.store.db.prepare('SELECT 1 FROM assistant_routine_occurrences WHERE rule_id=? AND revision=? AND scheduled_at=?').get(row.id,row.revision,due))due=null;
   }
   // Another process may already have refreshed and consumed this revision.
   this.store.db.prepare('UPDATE assistant_routines SET next_due=?,event_revision=? WHERE id=? AND revision=? AND event_revision IS ? AND next_due IS ?')
    .run(due,revision,row.id,row.revision,row.event_revision,row.next_due);
  }
  let admitted=0,afterDue='',afterId='';
  while(admitted<limit){
   const rows=this.store.db.prepare(`SELECT * FROM assistant_routines WHERE enabled=1 AND next_due<=? AND
    (next_due>? OR (next_due=? AND id>?)) ORDER BY next_due,id LIMIT ?`)
    .all(new Date(now).toISOString(),afterDue,afterDue,afterId,limit) as Row[];
   if(!rows.length)break;
   for(const row of rows){
    afterDue=row.next_due!;afterId=row.id;
    try{this.admit({ruleId:row.id,revision:row.revision,scheduledAt:row.next_due});admitted++;}
    catch(error){if(!(error instanceof StoreError&&error.statusCode===409))throw error;}
    if(admitted===limit)break;
   }
  }
  return admitted;
 }
}
