import {ensureTodoSchema} from './todo-schema.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {Store,StoreError,sha256} from './store.js';

const fields={title:z.string().trim().min(1).max(200),description:z.string().max(4000).default(''),dueAt:z.string().datetime({offset:true}).nullable().default(null),evidenceIds:z.array(z.string().uuid()).max(30).default([])};
export const todoInput=z.object({id:z.string().uuid().optional(),...fields}).strict();
export const archivedTodoSchema=z.object({...fields,id:z.string().uuid(),version:z.number().int().positive(),status:z.enum(['open','completed','cancelled']),createdAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true}),requestHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type Todo={id:string;version:number;title:string;description:string;dueAt:string|null;status:'open'|'completed'|'cancelled';evidenceIds:string[];createdAt:string;updatedAt:string};
/** User-confirmed local tasks have no calendar side effect and never infer a deadline. */
export class TodoStore {
 constructor(private store:Store){ensureTodoSchema(store.db);}
 private evidence(ids:string[]){if(new Set(ids).size!==ids.length||this.store.evidence(ids).length!==ids.length)throw new StoreError('Task evidence unavailable',409);}
 get(id:string):Todo{const row=this.store.db.prepare('SELECT json FROM todos WHERE id=?').get(id);if(!row)throw new StoreError('Task not found',404);return JSON.parse(String(row.json));}
 create(raw:unknown){const input=todoInput.parse(raw),id=input.id??randomUUID(),hash=sha256(JSON.stringify(input));const prior=this.store.db.prepare('SELECT request_hash FROM todos WHERE id=?').get(id);if(prior){if(prior.request_hash!==hash)throw new StoreError('Task operation conflicts',409);return this.get(id);}this.evidence(input.evidenceIds);const now=new Date().toISOString(),task:Todo={...input,id,status:'open',version:1,createdAt:now,updatedAt:now};this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(task))+1024);this.store.db.prepare('INSERT INTO todos VALUES(?,?,?,?,?,?)').run(id,now,task.status,1,hash,JSON.stringify(task));return task;}
 page(raw:unknown){const input=z.object({status:z.enum(['open','completed','cancelled']).optional(),cursor:z.string().max(300).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).strict().parse(raw),where:string[]=[],values:(string|number)[]=[];
  if(input.status){where.push('status=?');values.push(input.status);}if(input.cursor){let cursor:{at:string;id:string};try{cursor=z.object({at:z.string().datetime(),id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString()));}catch{throw new StoreError('Invalid task cursor');}where.push('(created_at<? OR (created_at=? AND id<?))');values.push(cursor.at,cursor.at,cursor.id);}
  const rows=this.store.db.prepare(`SELECT json FROM todos ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values,input.limit+1),items=rows.slice(0,input.limit).map(r=>JSON.parse(String(r.json)) as Todo),last=items.at(-1);
  return {items,nextCursor:rows.length>input.limit&&last?Buffer.from(JSON.stringify({at:last.createdAt,id:last.id})).toString('base64url'):null};
 }
 update(id:string,raw:unknown){const input=z.object({version:z.number().int().positive(),title:fields.title.optional(),description:fields.description.optional(),dueAt:fields.dueAt.optional(),evidenceIds:fields.evidenceIds.optional(),status:z.enum(['open','completed','cancelled']).optional()}).strict().parse(raw),prior=this.get(id);if(prior.version!==input.version)throw new StoreError('Task changed; reload before saving',409);if(input.evidenceIds)this.evidence(input.evidenceIds);const task={...prior,...input,version:prior.version+1,updatedAt:new Date().toISOString()};this.store.reserveMetadata(Math.max(0,Buffer.byteLength(JSON.stringify(task))-Buffer.byteLength(JSON.stringify(prior))));const changed=this.store.db.prepare('UPDATE todos SET json=?,version=?,status=? WHERE id=? AND version=?').run(JSON.stringify(task),task.version,task.status,id,input.version);if(!changed.changes)throw new StoreError('Task changed',409);return task;}
}
export function registerTodoRoutes(app:FastifyInstance,store:Store){const todos=new TodoStore(store);app.get('/api/todos',async req=>todos.page(req.query));app.post('/api/todos',async(req,reply)=>reply.code(201).send(todos.create(req.body)));app.patch('/api/todos/:id',async req=>todos.update(z.string().uuid().parse((req.params as {id:string}).id),req.body));return todos;}
