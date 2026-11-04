import type {ServerFeatureAdapter} from './index.js';

/** actions: the actions-services plugin owns the domain objects, proposal poll
 * and the activation-guarded route table; the adapter only mounts the
 * contribution so feature revocation still fences every route at once. */
export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.actions',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.assertCurrent();
    services.actionsServices.routes(app);
  },
};
