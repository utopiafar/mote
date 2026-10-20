// Frozen original reader from af11ab7c for full-output equivalence, not a product path.
import {operationStepStateSchema,operationStateSchema,type OperationSummary,type OperationState,type OperationPage,type OperationDetail,type OperationChanges} from '@mote/shared';
import {StoreError,type ExecutionStorage} from '../src/execution-storage.js';
const states=operationStepStateSchema.options;
const waitingReason="CASE WHEN state IN ('blocked','waiting','failed') THEN (SELECT CASE e.error WHEN 'processor_still_running' THEN 'processor_response_unknown' ELSE e.error END FROM execution_steps e JOIN execution_operation_steps o ON o.step_id=e.id WHERE o.operation_id=operation_progress.id AND o.active=1 AND e.state='blocked' AND e.error IN ('awaiting_confirmation','processor_response_unknown') ORDER BY e.updated_at DESC LIMIT 1) END AS waiting_reason";
const summary=(row:Record<string,unknown>):OperationSummary=>({id:String(row.id),kind:String(row.kind)||'processing',state:row.state as OperationState,total:Number(row.total),notScheduled:Number(row.not_scheduled),optionalIssues:Number(row.total)-Number(row.not_scheduled)-states.reduce((sum,state)=>sum+Number(row[state]),0),counts:Object.fromEntries(states.map(state=>[state,Number(row[state])])) as OperationSummary['counts'],createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),...(row.waiting_reason?{waitingReason:row.waiting_reason as OperationSummary['waitingReason']}:{})});
/** Reads only the incremental execution projection; never scans evidence or original files. */
export class Operations {
 /** Omit userId only in quarantined legacy composition. Production binds one
  * immutable host-established user for the lifetime of this reader. */
 constructor(private store:ExecutionStorage,private userId?:string){if(userId!==undefined&&!userId)throw new StoreError('Operation user required',400);}
 private filter(prefix=''){return this.userId===undefined?{sql:'',values:[] as string[]}:{sql:` AND ${prefix}user_id=?`,values:[this.userId]};}
 page(args:{state?:OperationState;kind?:string;cursor?:number;limit?:number}={}):OperationPage{
  const clauses=['total>0'],values:(string|number)[]=[],position=this.userId===undefined?'rowid':'user_position';
  if(this.userId!==undefined){clauses.push('user_id=?');values.push(this.userId);}
  if(args.state){clauses.push('state=?');values.push(args.state);}if(args.kind){clauses.push('kind=?');values.push(args.kind);}if(args.cursor){clauses.push(position+'<?');values.push(args.cursor);}
  const limit=Math.max(1,Math.min(args.limit??20,100)),rows=this.store.db.prepare(`SELECT rowid,*,${waitingReason} FROM operation_progress WHERE ${clauses.join(' AND ')} ORDER BY ${position} DESC LIMIT ?`).all(...values,limit+1);
  return {items:rows.slice(0,limit).map(summary),nextCursor:rows.length>limit?Number(rows[limit-1][position]):null,changeCursor:this.changeCursor()};
 }
 detail(id:string,cursor=0,limit=50):OperationDetail{
  const filter=this.filter(),row=this.store.db.prepare(`SELECT *,${waitingReason} FROM operation_progress WHERE id=? AND total>0${filter.sql}`).get(id,...filter.values);if(!row)throw new StoreError('Operation not found',404);
  const position=this.userId===undefined?'rowid':'user_position',stepFilter=this.filter('e.');
  const rows=this.store.db.prepare(`SELECT e.${position} position,e.id,e.kind,e.state,e.attempts,e.available_at,e.error,e.updated_at,o.active,o.optional FROM execution_operation_steps o JOIN execution_steps e ON e.id=o.step_id WHERE o.operation_id=? AND e.${position}>?${stepFilter.sql} ORDER BY e.${position} LIMIT ?`).all(id,cursor,...stepFilter.values,limit+1);
  return {operation:summary(row),steps:rows.slice(0,limit).map(step=>({id:String(step.id),kind:String(step.kind).startsWith('file-step.')?'file-step':String(step.kind).startsWith('query.run.')?'query.run':String(step.kind).startsWith('insight.run.')?'insight.run':String(step.kind).startsWith('lifecycle-window.')?'lifecycle-window':String(step.kind).startsWith('embedding.query.')?'embedding.query':String(step.kind),state:step.state as OperationState,attempts:Number(step.attempts),current:Boolean(step.active),...(step.optional?{optional:true}:{}),notScheduled:Boolean(step.optional)&&step.state==='blocked'&&['archive_only','summary_disabled','appledouble_metadata'].includes(String(step.error)),availableAt:Number(step.available_at),updatedAt:Number(step.updated_at),...(step.error?{reason:/^[a-z][a-z0-9_]{0,80}$/.test(String(step.error))?String(step.error):'processing_failed'}:{}),dependencies:this.store.db.prepare('SELECT dependency_id FROM execution_dependencies WHERE step_id=? ORDER BY dependency_id LIMIT 100').all(step.id).map(row=>String(row.dependency_id))})),nextCursor:rows.length>limit?Number(rows[limit-1].position):null};
 }
 private changeCursor(){
  return this.userId===undefined?Number(this.store.db.prepare('SELECT coalesce(max(seq),0) n FROM operation_changes').get()!.n):Number(this.store.db.prepare('SELECT next_change FROM operation_user_sequences WHERE user_id=?').get(this.userId)?.next_change??0);
 }
 changes(since:number):OperationChanges{
  const filter=this.filter(),position=this.userId===undefined?'seq':'user_seq',last=this.changeCursor();
  const range=this.store.db.prepare(`SELECT coalesce(min(${position}),0) first FROM operation_changes WHERE 1=1${filter.sql}`).get(...filter.values)!;
  if(since>last||since>0&&since<Number(range.first)-1||since>0&&since<last&&!Number(range.first))return {ids:[],cursor:last,reset:true,hasMore:false};
  const rows=this.store.db.prepare(`SELECT ${position} position,operation_id FROM operation_changes WHERE ${position}>?${filter.sql} ORDER BY ${position} LIMIT 201`).all(since,...filter.values),page=rows.slice(0,200);
  return {ids:[...new Set(page.map(row=>String(row.operation_id)))],cursor:page.length?Number(page.at(-1)!.position):since,reset:false,hasMore:rows.length>200};
 }
}
