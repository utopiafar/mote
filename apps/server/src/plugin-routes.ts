import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {PluginCenter} from './plugin-center.js';
import type {MemoryBindings} from './memory-bindings.js';
import type {MemoryAutomation} from './memory-automation.js';

/** Owner-only control plane; no methods are registered in query agent tools. */
export function registerPluginRoutes(app:FastifyInstance,{plugins,bindings,automation,owner}:{plugins:PluginCenter;bindings:MemoryBindings;automation:MemoryAutomation;owner:(request:FastifyRequest)=>void}){
  const id=(request:FastifyRequest)=>z.object({id:z.string().min(1)}).parse(request.params).id;
  app.get('/api/plugins',async request=>{owner(request);return plugins.view();});
  app.post('/api/plugins/resolve',async request=>{owner(request);return plugins.resolve(request.body);});
  app.post('/api/plugins/install',async request=>{owner(request);return plugins.install(request.body);});
  app.post('/api/plugins/:id/uninstall',async request=>{owner(request);return plugins.uninstall(id(request),request.body);});
  app.post('/api/plugin-instances',async request=>{owner(request);return plugins.configure(undefined,request.body);});
  app.patch('/api/plugin-instances/:id',async request=>{owner(request);return plugins.configure(id(request),request.body);});
  for(const action of ['check','enable','disable'] as const)app.post('/api/plugin-instances/:id/'+action,async request=>{owner(request);return plugins.action(id(request),action,request.body);});
  app.get('/api/memory-spaces/default/binding',async request=>{owner(request);return bindings.view();});
  for(const action of ['pause','resume','stop'] as const)app.post('/api/memory-spaces/default/binding/'+action,async request=>{owner(request);automation.command(action,request.body);return bindings.view();});
  app.post('/api/memory-spaces/default/binding/prepare',async request=>{owner(request);return bindings.prepare(request.body);});
  for(const action of ['activate','retry','cancel'] as const)app.post('/api/memory-spaces/default/binding/'+action,async request=>{owner(request);return bindings.action(action,request.body);});
}
