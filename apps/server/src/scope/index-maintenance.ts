import {z} from 'zod';
import type {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {EXECUTION_POLICIES} from '../execution-policy.js';
import {ExecutionFailure} from '../execution-engine.js';
import {rebuildPrivateIndex} from './private-data-schema.js';
import {registerAuthenticatedRoute,type ScopedRuntime} from './http.js';
import type {TaskExecution} from './task-execution.js';
import {missing} from './private-data-sql.js';

/** Fixed host maintenance over the existing lexical index. No account service,
 * private context, model connection or candidate body is exposed to an admin. */
export function registerIndexMaintenance(runtime:ScopedRuntime,db:DatabaseSync,execution:TaskExecution){
 const kind='index.rebuild',input=z.object({operationId:z.string().uuid()}).strict();
 const current=(userId:string,epoch:number)=>Boolean(db.prepare('SELECT 1 FROM auth_accounts WHERE user_id=? AND disabled=0 AND administrator=1 AND authorization_epoch=?').get(userId,epoch));
 const receipt=(id:string)=>{const task=execution.engine.get(id);if(!task||task.kind!==kind)throw missing();return {id:task.id,operationId:String(task.input.operationId),state:task.state,attempts:task.attempts,...(task.error?{error:task.error}:{})};};
 execution.register({kind,pool:kind,concurrency:()=>1,policy:EXECUTION_POLICIES.deterministic,parseInput:raw=>input.parse(raw),
  authorizeInput:context=>runtime.authority.assertAdministrator(context),
  resources:()=>[{scope:'shared',key:'lexical-index-maintenance'}],
  validate:task=>!!task.ownership&&current(task.ownership.userId,task.ownership.authorizationEpoch),
  execute:async run=>{run.grant.assert();await yieldTurn();run.grant.assert();return {};},
  commit:run=>{
   // M05 invokes commit synchronously in its lease-fenced SQLite transaction.
   // Read live owners, sources and heads here; nothing captured before the
   // asynchronous boundary may reintroduce withdrawn evidence.
   if(!current(run.context.userId,run.context.authorizationEpoch))throw new ExecutionFailure('stale','grant_revoked');
   rebuildPrivateIndex(db);
  },classify:error=>error instanceof ExecutionFailure?error:new ExecutionFailure('permanent','index_maintenance_failed')});
 registerAuthenticatedRoute(runtime,{method:'GET',url:'/api/admin/index',administrator:true,handle:(_context,request)=>{z.object({}).strict().parse(request.query);const latest=db.prepare('SELECT id FROM execution_steps WHERE kind=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(kind);return {scope:'instance-index',mode:'text',index:'lexical',contentVisible:false,...(latest?{job:receipt(String(latest.id))}:{})};}});
 registerAuthenticatedRoute(runtime,{method:'POST',url:'/api/admin/index/rebuild',administrator:true,handle:(context,request)=>{const value=input.parse(request.body),task=execution.forUser(context).submitSync({kind,operationId:'index:'+value.operationId,input:value});return receipt(task.id);}});
 registerAuthenticatedRoute(runtime,{method:'POST',url:'/api/admin/index/:id/cancel',administrator:true,handle:(_context,request)=>{z.object({}).strict().parse(request.body??{});const {id}=z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(request.params);receipt(id);execution.engine.cancel(id);return receipt(id);}});
}
