import {z} from 'zod';
import {operationStateSchema} from '@mote/shared';
import {registerUserRoute,type ScopedRuntime} from './http.js';
import {EXECUTION_DOMAIN,type TaskExecution,type UserTaskService} from './task-execution.js';

/** Restores only the scoped task/operations capability. Business kinds remain
 * unavailable until a trusted module registers their complete scoped handler. */
export function registerTaskRoutes(runtime:ScopedRuntime,execution:TaskExecution){
 runtime.services.registerUser(EXECUTION_DOMAIN,{scope:'user',create:context=>execution.forUser(context),lifecycle:execution.lifecycle()});
 const task=(services:ReturnType<ScopedRuntime['services']['forUser']>)=>services.get<UserTaskService>(EXECUTION_DOMAIN);
 const identifier=z.object({id:z.string().min(1).max(256)});
 const page=z.object({cursor:z.coerce.number().int().safe().nonnegative().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict();
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/tasks',service:EXECUTION_DOMAIN,handle:({services,request})=>task(services).submit(request.body)});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/tasks',service:EXECUTION_DOMAIN,handle:({services,request})=>task(services).list(page.parse(request.query))});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/tasks/queues',service:EXECUTION_DOMAIN,handle:({services,request})=>{z.object({}).strict().parse(request.query);return task(services).queues();}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/tasks/:id',service:EXECUTION_DOMAIN,handle:({services,request})=>task(services).get(identifier.parse(request.params).id)});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/tasks/:id/cancel',service:EXECUTION_DOMAIN,handle:({services,request})=>{z.object({}).strict().parse(request.body??{});return task(services).cancel(identifier.parse(request.params).id);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/tasks/:id/retry',service:EXECUTION_DOMAIN,handle:({services,request})=>task(services).retry(identifier.parse(request.params).id,z.object({confirmUnknown:z.boolean().optional()}).strict().parse(request.body??{}))});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/operations',service:EXECUTION_DOMAIN,handle:({services,request})=>task(services).operations().page(page.extend({state:operationStateSchema.optional(),kind:z.string().min(1).max(100).optional()}).parse(request.query))});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/operations/changes',service:EXECUTION_DOMAIN,handle:({services,request})=>task(services).operations().changes(z.object({since:z.coerce.number().int().safe().nonnegative().default(0)}).strict().parse(request.query).since)});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/operations/:id',service:EXECUTION_DOMAIN,handle:({services,request})=>{const {cursor,limit}=page.parse(request.query);return task(services).operations().detail(identifier.parse(request.params).id,cursor,limit);}});
}
