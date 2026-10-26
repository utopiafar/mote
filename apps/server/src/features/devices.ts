import { heartbeatSchema } from '@mote/shared';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import {firstDeviceData} from '../first-device-data.js';

/** devices: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{connections,credential,diagnostics,store,files,evidenceReader}:Pick<FeatureServices,"connections"|"credential"|"diagnostics"|"store"|"files"|"evidenceReader">){
app.post('/api/devices/heartbeat',async req=>{const beat=heartbeatSchema.parse(req.body),c=credential(req);if(c){connections.assertOwnDevice(c,beat);connections.assertPlatform(c,beat.platform);}const result=store.heartbeat(beat);diagnostics.record('queue.snapshot',{queueDepth:beat.queueDepth});return result;});
app.get('/api/devices',async()=>({items:store.devices()}));
// Owner-only through the existing default-deny app hook. Do not add this route
// to collector or MCP allowlists: it is a cross-device archive view.
app.get('/api/devices/first-data',async()=>firstDeviceData(store,files,evidenceReader));
}
