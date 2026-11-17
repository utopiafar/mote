import type {FastifyInstance} from 'fastify';
import type {DevicesSource,DeviceRouteContext} from '../plugins/devices-source.js';
import type {FeatureRoute} from './index.js';

/** The executable Devices owner has already created and started this source. */
export function devicesFeature(source:DevicesSource,context:DeviceRouteContext):FeatureRoute {
  return Object.freeze({id:'mote.devices',mount(app:FastifyInstance){source.routes(app,context);}});
}
