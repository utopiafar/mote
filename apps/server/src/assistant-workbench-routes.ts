import {z} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AssistantWorkbench} from './assistant-workbench.js';
import {StoreError} from './store.js';

export function registerAssistantWorkbenchRoutes(app:FastifyInstance,workbench:AssistantWorkbench,
  options:{credential:(request:FastifyRequest)=>unknown;assertRequestActive:(request:FastifyRequest)=>void;available:()=>boolean}){
  const owner=(request:FastifyRequest)=>{
    options.assertRequestActive(request);if(options.credential(request))throw new StoreError('Owner access required',403);
    if(!options.available())throw new StoreError('Workspace is unavailable',503);
  };
  app.get('/api/assistant/workbench',async(request,reply)=>{
    owner(request);reply.header('Cache-Control','no-store');
    const query=z.object({request:z.string().max(16000)}).strict().parse(request.query);
    let value:unknown;try{value=JSON.parse(query.request);}catch{throw new StoreError('Invalid workspace request');}
    const result=await workbench.read(value);owner(request);return result;
  });
  app.post('/api/assistant/workbench/commands',{bodyLimit:32768},async(request,reply)=>{
    owner(request);reply.header('Cache-Control','no-store');const result=await workbench.command(request.body);owner(request);return result;
  });
}
