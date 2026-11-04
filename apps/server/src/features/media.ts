import type { FastifyInstance } from 'fastify';
import { ConnectionError } from '../connections.js';
import type { FeatureServices } from '../feature-services.js';
import { moteText } from '../i18n.js';
import { registerProcessingRoutes } from '../processing-routes.js';
import type {ServerFeatureAdapter} from './index.js';

/** media: owns its transport, data and command contributions, including the
 * perception and managed-media routes formerly mounted by the processing
 * feature adapter. */
export function register(app:FastifyInstance,{connections,credential,mediaRange,store,processing,perception,mediaAssets,mediaPreparation,config,withMediaOwnerBatch,withMediaOwnerIntent}:Pick<FeatureServices,"connections"|"credential"|"mediaRange"|"store"|"processing"|"perception"|"mediaAssets"|"mediaPreparation"|"config"|"withMediaOwnerBatch"|"withMediaOwnerIntent">){
  registerProcessingRoutes(app,{withOwnerBatch:withMediaOwnerBatch,withOwnerIntent:withMediaOwnerIntent,perception,mediaAssets,mediaPreparation,media:config.media});
  app.get('/api/media-activity',async req=>{
    const query=mediaRange.parse(req.query),c=credential(req);
    if(c){connections.assertActive(c);if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText("只能读取本设备的媒体采集统计。"));query.deviceId=c.deviceId;}
    return store.mediaActivity(query);
  });
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.media',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.media'));
    register(app,services);
  },
};
