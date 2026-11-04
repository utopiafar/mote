import type {ServerFeatureAdapter} from './index.js';

/** Mote's live feature inventory projection for the owner control plane. */
export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.features',version:'1',surface:'data',runtime:'host'},
  factory:(app,_scope,services)=>{app.get('/api/features',async()=>services.featureInventory());},
};
