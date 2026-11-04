import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';
import {createCollectionService} from './domain.mjs';

export const sdkVersion = PLUGIN_SDK_VERSION;
export const basePath = '/api/connectors/template-collection';

/** Deployment adapter for the current Central connector host — the real
 * install path used by `plugin-dev` and `connectors.modules`. The host
 * creates one scoped connector instance and binds `ctx.state` to the
 * instance's persistent namespace; the package publishes its own owner
 * routes. Domain, state and error behavior are shared with the SDK host
 * entry in `plugin.mjs`. */
export default {
  apiVersion: 1,
  id: 'template-collection-source',
  statusKey: 'collection',
  sourceKinds: [],
  create(ctx) {
    if (!ctx?.state) throw Error('The Central host did not provide instance state');
    const service = createCollectionService({state: ctx.state});
    return {
      init: () => service.load(),
      status: () => ({sdkVersion, ...service.port.summary()}),
      configure(host) {
        host.ownerRoute({
          method: 'GET',
          path: `${basePath}/state`,
          handler: () => service.port.state(),
        });
        host.ownerRoute({
          method: 'GET',
          path: `${basePath}/summary`,
          handler: () => service.port.summary(),
        });
        host.ownerRoute({
          method: 'POST',
          path: `${basePath}/items`,
          handler: request => service.port.add(request.body),
          bodyLimit: 8192,
        });
      },
      close: () => service.close(),
    };
  },
};
