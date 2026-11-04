import type {FastifyInstance} from 'fastify';
import {MOTE_PROTOCOL_RANGE} from '@mote/shared';
import type {FeatureRoute} from './index.js';

/** Minimal bootstrap health remains a host primitive (H), not a business
 * contribution. It exposes only liveness, protocol and version. */
export function healthFeature(serverVersion:string):FeatureRoute {
  return Object.freeze({id:'mote.system',mount(app:FastifyInstance){
    app.get('/api/health',async()=>({ok:true,version:serverVersion,protocol:MOTE_PROTOCOL_RANGE}));
  }});
}
