import {operationStepStateSchema,operationStateSchema,type OperationSummary,type OperationState,type OperationPage,type OperationDetail,type OperationChanges} from '@mote/shared';
import {z} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {StoreError,type Store} from './store.js';
const states=operationStepStateSchema.options;
const summary=(row:Record<string,unknown>):OperationSummary=>({id:String(row.id),kind:String(row.kind)||'processing',state:row.state as OperationState,total:Number(row.total),notScheduled:Number(row.not_scheduled),counts:Object.fromEntries(states.map(state=>[state,Number(row[state])])) as OperationSummary['counts'],createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)});
/** Reads only the incremental execution projection; never scans evidence or original files. */
export class Operations {
 constructor(private store:Store){}
 page(args:{state?:OperationState;kind?:string;cursor?:number;limit?:number}={}):OperationPage{
  const clauses=['total>0'],values:(string|number)[]=[];
  if(args.state){clauses.push('state=?');values.push(args.state);}if(args.kind){clauses.push('kind=?');values.push(args.kind);}if(args.cursor){clauses.push('rowid<?');values.push(args.cursor);}
  const limit=Math.max(1,Math.min(args.limit??20,100)),rows=this.store.db.prepare(`SELECT rowid,* FROM operation_progress WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`).all(...values,limit+1);
  return {items:rows.slice(0,limit).map(summary),nextCursor:rows.length>limit?Number(rows[limit-1].rowid):null,changeCursor:Number(this.store.db.prepare('SELECT coalesce(max(seq),0) n FROM operation_changes').get()!.n)};
 }
 detail(id:string,cursor=0,limit=50):OperationDetail{
  const row=this.store.db.prepare('SELECT * FROM operation_progress WHERE id=? AND total>0').get(id);if(!row)throw new StoreError('Operation not found',404);
  const rows=this.store.db.prepare('SELECT e.rowid,e.id,e.kind,e.state,e.attempts,e.available_at,e.error,e.updated_at,o.active,o.optional FROM execution_operation_steps o JOIN execution_steps e ON e.id=o.step_id WHERE o.operation_id=? AND e.rowid>? ORDER BY e.rowid LIMIT ?').all(id,cursor,limit+1);
  return {operation:summary(row),steps:rows.slice(0,limit).map(step=>({id:String(step.id),kind:String(step.kind).startsWith('file-step.')?'file-step':String(step.kind),state:step.state as OperationState,attempts:Number(step.attempts),current:Boolean(step.active),notScheduled:Boolean(step.optional)&&step.state==='blocked',availableAt:Number(step.available_at),updatedAt:Number(step.updated_at),...(step.error?{reason:/^[a-z][a-z0-9_]{0,80}$/.test(String(step.error))?String(step.error):'processing_failed'}:{}),dependencies:this.store.db.prepare('SELECT dependency_id FROM execution_dependencies WHERE step_id=? ORDER BY dependency_id LIMIT 100').all(step.id).map(row=>String(row.dependency_id))})),nextCursor:rows.length>limit?Number(rows[limit-1].rowid):null};
 }
 changes(since:number):OperationChanges{
  const range=this.store.db.prepare('SELECT coalesce(min(seq),0) first,coalesce(max(seq),0) last FROM operation_changes').get()!;
  if(since>Number(range.last)||since>0&&since<Number(range.first)-1)return {ids:[],cursor:Number(range.last),reset:true,hasMore:false};
  const rows=this.store.db.prepare('SELECT seq,operation_id FROM operation_changes WHERE seq>? ORDER BY seq LIMIT 201').all(since),page=rows.slice(0,200);
  return {ids:[...new Set(page.map(row=>String(row.operation_id)))],cursor:page.length?Number(page.at(-1)!.seq):since,reset:false,hasMore:rows.length>200};
 }
}
export function registerOperations(app:FastifyInstance,operations:Operations,isCollector:(request:FastifyRequest)=>boolean){
 const owner=(req:FastifyRequest)=>{if(isCollector(req))throw new StoreError('Owner access required',403);};
 app.get('/api/operations',async req=>{owner(req);return operations.page(z.object({state:operationStateSchema.optional(),kind:z.enum(['capture','file','workflow','memory']).optional(),cursor:z.coerce.number().int().max(Number.MAX_SAFE_INTEGER).positive().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query));});
 app.get('/api/operations/changes',async req=>{owner(req);return operations.changes(z.object({since:z.coerce.number().int().max(Number.MAX_SAFE_INTEGER).nonnegative().default(0)}).strict().parse(req.query).since);});
 app.get('/api/operations/:id',async req=>{owner(req);const {cursor,limit}=z.object({cursor:z.coerce.number().int().max(Number.MAX_SAFE_INTEGER).nonnegative().default(0),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);return operations.detail(z.object({id:z.string().min(1).max(256)}).parse(req.params).id,cursor,limit);});
}
