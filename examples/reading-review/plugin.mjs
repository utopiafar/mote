/** SDK host entry for the reading review domain.
 *
 * The factory owns one instance-scoped controller and publishes this package's
 * own typed port. It receives `ctx.state` from the host and never accepts a
 * package, installation or instance identity from the caller. */
import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';
import {createReadingReviewService} from './domain.mjs';
import {readingReviewPort} from './port.mjs';

export const sdkVersion = PLUGIN_SDK_VERSION;

export const readingReviewContribution = Object.freeze({
  id: 'reading-review.port',
  version: '1',
  surface: 'data',
  runtime: 'service',
  provides: [{
    kind: 'service',
    id: readingReviewPort.id,
    apiVersion: readingReviewPort.apiVersion,
    cardinality: 'single',
  }],
});

export function createPlugin(context) {
  if (!context?.state) throw Error('The Mote host did not provide instance state');
  const service = createReadingReviewService({state: context.state});
  context.scope.defer(() => service.close());
  return {
    prepare: () => service.load(),
    start() {
      context.provide(readingReviewContribution.id, readingReviewPort, service.port, 0);
    },
    quiesce: () => service.quiesce(),
    stop: () => service.quiesce(),
    dispose: () => service.close(),
  };
}

export const factory = createPlugin;

export default Object.freeze({
  id: 'example.reading-review',
  sdkVersion,
  contribution: readingReviewContribution,
  factory: createPlugin,
});
