import type {ServerFeatureAdapter} from './index.js';

/** Mote's live feature inventory projection for the owner control plane. The
 * common host snapshot is authoritative for selected domain plugins; the HTTP
 * feature host, Agent read tools and connector instances contribute the exact
 * route/command/ingress capabilities they registered. */
export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.features',version:'1',surface:'data',runtime:'host'},
  factory:(app,_scope,services,host)=>{app.get('/api/features',async()=>services.featureInventory([
    ...host.contributions(),
    ...services.agentFeatures.contributions(),
    ...services.connectors.contributions(),
  ]));},
};
