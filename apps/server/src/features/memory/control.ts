import type {FastifyInstance} from 'fastify';
import {memoryRecipeSettingsQuery,type MemoryRecipeSettingsPort} from '../../memory-recipe-settings.js';
import type {MemoryIntegrationSettingsPort} from '../../memory-integration-settings.js';
import type {MemoryStrategiesPort} from '../../memory-strategies.js';

export interface MemoryControlRouteDependencies {
  readonly strategies:Pick<MemoryStrategiesPort,'list'|'listIntegrations'>;
  readonly recipes:MemoryRecipeSettingsPort;
  readonly integration:MemoryIntegrationSettingsPort;
  readonly readable:()=>boolean;
  readonly writable:()=>boolean;
}

/** C21's recipe and integration selections. Reads keep serving a prepared
 * activation; writes require the current one. */
export function registerMemoryControlRoutes(app:FastifyInstance,dependencies:MemoryControlRouteDependencies){
  app.register(async child=>{
    child.addHook('onRequest',async(request,reply)=>{
      const write=request.method!=='GET'&&request.method!=='HEAD';
      if(write?!dependencies.writable():!dependencies.readable())return reply.code(503).send({error:'feature_unavailable'});
    });
    child.get('/api/memory-recipe-settings',async req=>{const query=memoryRecipeSettingsQuery.parse(req.query);return dependencies.recipes.view(query.sourceId,query.scope);});
    child.put('/api/memory-recipe-settings',{bodyLimit:8192},async req=>dependencies.recipes.configure(req.body));
    child.get('/api/memory-integration-recipes',async()=>({items:dependencies.strategies.listIntegrations()}));
    child.get('/api/memory-integration-settings',async()=>dependencies.integration.view());
    child.put('/api/memory-integration-settings',{bodyLimit:4096},async req=>dependencies.integration.configure(req.body));
    child.get('/api/memory-recipes',async()=>({items:dependencies.strategies.list()}));
  });
}
