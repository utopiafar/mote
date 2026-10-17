import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {registerUserRoute,type ScopedRuntime} from './http.js';
import type {Configurations} from './configuration.js';
import type {TaskExecution} from './task-execution.js';
import type {IngressHost} from './ingress.js';
import type {ScopedPluginHost} from './plugins.js';
import {ProcessingHost,PROCESSING_DOMAIN} from './processing.js';
import {registerProcessingImages} from './processing-images.js';
import {registerProcessingFiles} from './processing-files.js';
import type {ImportPythonPackConfig} from '../config.js';

export function registerProcessing(runtime:ScopedRuntime,db:DatabaseSync,configuration:Configurations,execution:TaskExecution,ingress:IngressHost,plugins:ScopedPluginHost,privateCursorKey:string,sourcePacks:readonly ImportPythonPackConfig[]=[]){
 const host=new ProcessingHost(runtime,db,configuration,execution,ingress,plugins,sourcePacks);
 const service=(services:ReturnType<ScopedRuntime['services']['forUser']>)=>services.get<ReturnType<ProcessingHost['forUser']>>(PROCESSING_DOMAIN);
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/processing',service:PROCESSING_DOMAIN,handle:({services})=>service(services).view()});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/processing/derivations',service:PROCESSING_DOMAIN,handle:({services,request})=>service(services).derive(request.body)});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/processing',service:PROCESSING_DOMAIN,handle:({services,request})=>service(services).submit(request.body)});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/processing/originals/:id',service:PROCESSING_DOMAIN,handle:({services,request})=>service(services).status('original:'+z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).id)});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/processing/artifacts/:id',service:PROCESSING_DOMAIN,handle:({services,request})=>service(services).artifact(z.object({id:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.params).id)});
 registerProcessingImages(runtime,db,host,execution);
 const files=registerProcessingFiles(runtime,db,host,ingress,execution,privateCursorKey);
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/file-processing',service:PROCESSING_DOMAIN,handle:({context})=>host.policies.view(context)});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/file-processing/test-local',service:PROCESSING_DOMAIN,handle:({services,request})=>service(services).testLocal(request.body)});
 registerUserRoute(runtime,{scope:'user',method:'PUT',url:'/api/file-processing',service:PROCESSING_DOMAIN,bodyLimit:262144,handle:({context,request})=>host.policies.save(context,request.body)});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/file-processing/match',service:PROCESSING_DOMAIN,handle:({context,request})=>host.policies.match(context,request.body)});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/file-processing/preview',service:PROCESSING_DOMAIN,handle:({context,request})=>host.policies.preview(context,request.body,files(context))});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/file-processing/reprocess',service:PROCESSING_DOMAIN,handle:({context,request})=>host.policies.reprocess(context,request.body,files(context),(token,refs,assertPreview)=>host.reprocessPolicies(context,token,refs,assertPreview))});

 registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/import-capabilities',handle:({context})=>host.importJobs.forUser(context).capabilities()});
 registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/import-source-packs',handle:({context})=>host.importJobs.forUser(context).sourcePacks()});
 registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/imports',handle:({context})=>host.importJobs.forUser(context).list()});
 registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'GET',url:'/api/imports/:id',handle:({context,request})=>host.importJobs.forUser(context).get(z.object({id:z.string().uuid()}).parse(request.params).id)});
 registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/imports',bodyLimit:360*1024*1024,handle:async({context,request,reply})=>reply.code(202).send(await host.importJobs.forUser(context).create(request.body))});
 for(const action of ['confirm','cancel'] as const)registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/imports/:id/'+action,handle:({context,request,reply})=>{z.object({}).strict().parse(request.body??{});return reply.code(action==='confirm'?202:200).send(host.importJobs.forUser(context)[action](z.object({id:z.string().uuid()}).parse(request.params).id));}});
 for(const action of ['prepare','retry'] as const)registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'POST',url:'/api/imports/:id/'+action,handle:async({context,request,reply})=>{const id=z.object({id:z.string().uuid()}).parse(request.params).id;if(action==='retry')z.object({}).strict().parse(request.body??{});return reply.code(202).send(await(action==='prepare'?host.importJobs.forUser(context).prepare(id,request.body):host.importJobs.forUser(context).retry(id)));}});
 registerUserRoute(runtime,{scope:'user',service:PROCESSING_DOMAIN,method:'DELETE',url:'/api/imports/:id',handle:({context,request})=>host.importJobs.forUser(context).delete(z.object({id:z.string().uuid()}).parse(request.params).id)});
 return host;
}
