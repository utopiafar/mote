import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {codexModels,providerModels} from './model-catalog.js';
import {modelProfileIdSchema,type ModelSettingsStore} from './model-settings.js';
export function registerModelSettingsRoutes(app:FastifyInstance,modelSettings:ModelSettingsStore,codex:Parameters<typeof codexModels>[1]){
 const connectionRate={rateLimit:{max:20,timeWindow:'1 minute'}};
  let codexCatalogPending:ReturnType<typeof codexModels>|undefined;
  app.get('/api/model-settings/codex-models',{config:connectionRate},async()=>codexCatalogPending??=codexModels(undefined,codex).finally(()=>{codexCatalogPending=undefined;}));
  app.get('/api/model-settings/profiles/:id/models',async req=>{const profile=modelSettings.select('chat',z.object({id:modelProfileIdSchema}).parse(req.params).id);return profile.settings.protocol==='codex-app-server'?codexModels(undefined,codex):providerModels(profile.settings);});
  app.post('/api/model-settings/models',{bodyLimit:65536,config:connectionRate},async req=>modelSettings.models(req.body));
  app.get('/api/model-settings',async()=>modelSettings.view());
  app.put('/api/model-settings',{bodyLimit:65536,config:connectionRate},async req=>modelSettings.update(req.body));
  app.delete('/api/model-settings',{bodyLimit:8192,config:connectionRate},async req=>modelSettings.reset(req.body));
  app.post('/api/model-settings/test',{bodyLimit:65536,config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async req=>modelSettings.test(req.body));
  const profileId=(params:unknown)=>z.object({id:modelProfileIdSchema}).parse(params).id;
  app.put('/api/model-settings/profiles/:id',{bodyLimit:65536,config:connectionRate},async req=>modelSettings.updateProfile(profileId(req.params),req.body));
  app.delete('/api/model-settings/profiles/:id',{bodyLimit:8192,config:connectionRate},async req=>modelSettings.deleteProfile(profileId(req.params),req.body));
  app.post('/api/model-settings/profiles/:id/test',{bodyLimit:65536,config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async req=>modelSettings.test(req.body,profileId(req.params)));
  app.post('/api/model-settings/profiles/:id/models',{bodyLimit:65536,config:connectionRate},async req=>modelSettings.models(req.body,profileId(req.params)));
  app.post('/api/model-settings/profiles/:id/copy',{bodyLimit:8192,config:connectionRate},async req=>modelSettings.copyProfile(profileId(req.params),req.body));
  app.put('/api/model-settings/defaults',{bodyLimit:8192,config:connectionRate},async req=>modelSettings.updateDefaults(req.body));
}
