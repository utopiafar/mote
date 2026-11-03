/** Deployment adapter for the current Central connector host.
 *
 * This is the real install path used by `plugin-dev` and
 * `connectors.modules`: the host creates one scoped connector instance, binds
 * `ctx.state` to that instance's persistent namespace, and lets the package
 * publish its own owner routes. The domain, comparison and state behavior are
 * shared with the SDK host entry in `plugin.mjs`. */
import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';
import {createReadingReviewService} from './domain.mjs';

export const sdkVersion = PLUGIN_SDK_VERSION;
export const basePath = '/api/connectors/reading-review';

export const customPage = Object.freeze({
  entry: 'web/index.html',
  methods: Object.freeze(['state', 'select-strategy', 'review']),
});

export default {
  apiVersion: 1,
  id: 'reading-review',
  statusKey: 'reading-review',
  sourceKinds: [],
  create(context) {
    if (!context?.state) throw Error('The Central host did not provide instance state');
    const service = createReadingReviewService({state: context.state});
    return {
      init: () => service.load(),
      status: () => ({sdkVersion, ...service.summary()}),
      configure(host) {
        host.ownerRoute({
          method: 'GET',
          path: `${basePath}/state`,
          handler: () => service.state(),
        });
        host.ownerRoute({
          method: 'PUT',
          path: `${basePath}/strategy`,
          handler: request => service.selectStrategy(request.body?.strategy),
        });
        host.ownerRoute({
          method: 'POST',
          path: `${basePath}/cards`,
          handler: request => service.addCard(request.body),
          bodyLimit: 8192,
        });
        host.ownerRoute({
          method: 'POST',
          path: `${basePath}/round`,
          handler: request => service.review(request.body),
          bodyLimit: 4096,
        });
      },
      close() {
        service.close();
      },
    };
  },
};
