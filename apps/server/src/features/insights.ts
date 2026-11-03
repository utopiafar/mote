import type {FastifyInstance} from 'fastify';
import type {FeatureServices} from '../feature-services.js';
import type {ServerFeatureScope} from '../feature-host.js';
import {createInsightServices} from '../plugins/insight-services.js';
import type {ServerFeatureAdapter} from './index.js';

type InsightFeatureServices=Pick<FeatureServices,'agent'|'availableModelConnections'|'diagnostics'|'insight'|'insightRuns'|'isClosing'|'modelAuthorizationHost'|'modelSettings'|'store'>;

/** The feature bridge only mounts the plugin-owned route table before listen.
 * C26B's run manager is still constructed by app.ts until K04 moves that one
 * ownership site; this bridge must not create a second manager. */
export function register(app:FastifyInstance,services:InsightFeatureServices,scope?:ServerFeatureScope){
  const plugin=createInsightServices({
    runs:services.insightRuns,
    query:services.insight,
    modelAuthorization:services.modelAuthorizationHost,
    availableModelConnections:services.availableModelConnections,
    agent:services.agent,
    modelSettings:services.modelSettings,
    isClosing:services.isClosing,
    diagnostics:services.diagnostics,
    readHistory:query=>services.store.insights(query),
    readReport:id=>services.store.insight(id),
  });
  plugin.prepare();plugin.start();
  scope?.defer(()=>plugin.close());
  plugin.routes(app);
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.insights',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.insights'));
    register(app,services,scope);
  },
};
