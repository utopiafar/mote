import type {FastifyInstance} from 'fastify';
import {MOTE_PROTOCOL_RANGE} from '@mote/shared';
import type {FeatureRoute} from './index.js';

/** The default System surface exposes only liveness, protocol and version.
 * Its selected build declaration owns activation; business status stays separate. */
export function healthFeature(serverVersion:string):FeatureRoute {
  return Object.freeze({id:'mote.system',mount(app:FastifyInstance){
    app.get('/api/health',async()=>({ok:true,version:serverVersion,protocol:MOTE_PROTOCOL_RANGE}));
  }});
}
