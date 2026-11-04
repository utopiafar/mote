import {StoreError} from '../store.js';
import {codingSourceRoutesFor} from '../coding-source-plugin.js';
import type {ServerFeatureAdapter} from './index.js';

/** Pre-H14 bridge: the coding source plugin owns activation and HTTP dispatch;
 * this feature only mounts its stable route table once before listen. */
export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.coding',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.assertCurrent();
    const routes=codingSourceRoutesFor(services.sourcePipelines);
    if(!routes)throw new StoreError('Coding source routes are unavailable',503);
    routes.mount(app);
  },
};
