import type { FastifyInstance } from 'fastify';
import { MOTE_PROTOCOL_RANGE } from '@mote/shared';
import type { FeatureServices } from '../feature-services.js';
import type {ServerFeatureAdapter} from './index.js';

type HealthServices = Pick<FeatureServices,"serverVersion">;

/** Minimal bootstrap health remains a host primitive (H), not a business contribution.
 * It exposes only liveness, protocol and version; it never reads services or storage.
 * Status, build identity, usage and diagnostics are registered by the observability
 * platform's own route contribution. */
export function registerBootstrapHealth(app:FastifyInstance,{serverVersion}:HealthServices){
  app.get('/api/health',async()=>({ok:true,version:serverVersion,protocol:MOTE_PROTOCOL_RANGE}));
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.system',version:'1',surface:'data',runtime:'host'},
  factory:(app,_scope,services)=>registerBootstrapHealth(app,services),
};
