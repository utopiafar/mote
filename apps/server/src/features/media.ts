import type { FastifyInstance } from 'fastify';
import { ConnectionError } from '../connections.js';
import type { FeatureServices } from '../feature-services.js';
import { moteText } from '../i18n.js';

/** media: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{connections,credential,mediaRange,store}:Pick<FeatureServices,"connections"|"credential"|"mediaRange"|"store">){
app.get('/api/media-activity',async req=>{
    const query=mediaRange.parse(req.query),c=credential(req);
    if(c){connections.assertActive(c);if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText("只能读取本设备的媒体采集统计。"));query.deviceId=c.deviceId;}
    return store.mediaActivity(query);
  });
}
