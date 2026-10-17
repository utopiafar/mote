import {memoryPageSchema,memoryReadFiltersSchema} from './memory-data.js';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {registerUserRoute,type ScopedRuntime} from './http.js';
import type {Configurations} from './configuration.js';
import type {TaskExecution} from './task-execution.js';
import type {ScopedPluginHost} from './plugins.js';
import type {MemoryProviderOptions} from './memory-providers.js';
import {MemoryHost} from './memory.js';
import {MEMORY_DOMAIN} from './memory-schema.js';

const memoryQuery=(raw:unknown)=>Object.fromEntries(Object.entries(z.record(z.unknown()).parse(raw)).map(([key,value])=>[key,['includeHistory','includeStale'].includes(key)&&['true','false'].includes(String(value))?value==='true':value]));
const memoryReadQuery=(raw:unknown)=>{const fields=memoryQuery(raw);return Object.keys(fields).length?memoryReadFiltersSchema.parse(fields):undefined;};

export function registerMemory(runtime:ScopedRuntime,db:DatabaseSync,configuration:Configurations,execution:TaskExecution,plugins:ScopedPluginHost,providerOptions:MemoryProviderOptions={},questions?:import('./owner-questions.js').ScopedOwnerQuestions){
 const host=new MemoryHost(runtime,db,configuration,execution,plugins,providerOptions,undefined,questions),service=(context:Parameters<MemoryHost['forUser']>[0])=>host.forUser(context);
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory',handle:({context})=>service(context).view()});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/jobs',handle:({context,request})=>service(context).jobs(request.query)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/materials/:id',handle:({context,request})=>service(context).materialSelection((request.params as {id:string}).id,request.query)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/recipes',handle:({context})=>service(context).recipes()});
 for(const kind of ['pause','resume','retry'] as const)registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/jobs/:id/'+kind,handle:({context,request})=>service(context).jobControl((request.params as {id:string}).id,kind)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/audit',handle:({context,request})=>service(context).audit(request.query)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/jobs/:id/review',handle:({context,request})=>service(context).review((request.params as {id:string}).id)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/audit/:id',handle:({context,request})=>service(context).auditMemory((request.params as {id:string}).id,z.object({version:z.coerce.number().int().positive().optional()}).strict().parse(request.query).version)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/jobs',handle:({context,request})=>service(context).submit(request.body)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory-integrations',handle:({context,request})=>service(context).integrate(request.body)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/jobs/:id',handle:({context,request})=>service(context).job((request.params as {id:string}).id)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/jobs/:id/cancel',handle:({context,request})=>service(context).cancel((request.params as {id:string}).id)});
 for(const kind of ['pause','resume','stop'] as const)registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/'+kind,handle:({context,request})=>service(context).control(kind,request.body)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memories',handle:({context,request})=>service(context).page(memoryPageSchema.parse(memoryQuery(request.query)))});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/reconcile',handle:({context})=>service(context).reconcile()});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memories/:id/versions/:version',handle:({context,request})=>{const input=z.object({id:z.string().uuid(),version:z.coerce.number().int().positive()}).parse(request.params);return service(context).readVersion(input.id,input.version,memoryReadQuery(request.query));}});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memories/:id',handle:({context,request})=>service(context).read((request.params as {id:string}).id,memoryReadQuery(request.query))});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memories/:id/correct',handle:({context,request})=>service(context).correct((request.params as {id:string}).id,request.body)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'DELETE',url:'/api/memories/:id',handle:({context,request})=>service(context).delete((request.params as {id:string}).id)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/bindings',handle:({context,request})=>host.bindings.prepare(context,request.body)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'GET',url:'/api/memory/bindings/:id',handle:({context,request})=>host.bindings.view(context,(request.params as {id:string}).id)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/bindings/:id/activate',handle:({context,request})=>host.bindings.activate(context,(request.params as {id:string}).id,request.body)});
 registerUserRoute(runtime,{scope:'user',service:MEMORY_DOMAIN,method:'POST',url:'/api/memory/bindings/:id/cancel',handle:async({context,request})=>{const result=host.bindings.cancel(context,(request.params as {id:string}).id);await service(context).reconcile();return result;}});
 return host;
}
