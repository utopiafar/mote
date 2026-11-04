import type {FastifyInstance} from 'fastify';
import type {FeatureInventory} from '@mote/shared';
import type {FeatureRoute} from './index.js';

/** The owner feature inventory projects the common host snapshot plus the HTTP
 * and Agent capabilities the selected local contributions registered. */
export function inventoryFeature(inventory:()=>FeatureInventory):FeatureRoute {
  return Object.freeze({id:'mote.features',mount(app:FastifyInstance){app.get('/api/features',async()=>inventory());}});
}
