import {createCollectionService} from './domain.mjs';
import {collectionPort} from './port.mjs';

export const manifest = {
  apiVersion: 1,
  id: 'template.collection',
  title: 'Template collection domain',
  version: '0.1.0',
  contributions: [
    {id: 'template-collection.port', version: '1', surface: 'data', entry: 'plugin.mjs'},
  ],
  required: [],
  optional: [],
};

/** Service-runtime entry for a service-capable PluginHost. The factory owns
 * construction; lifecycle phases bound to the host activation do the rest —
 * `prepare` loads durable state, `start` provides the port, `quiesce`/`stop`
 * refuse new writes, `dispose` releases resources. `ctx.state` is injected by
 * the host scoped to this package installation. */
export function createPlugin(context) {
  const service = createCollectionService({state: context.state});
  context.scope.defer(() => service.close());
  return {
    manifest,
    prepare: () => service.load(),
    start() { context.provide('template-collection.port', collectionPort, service.port, 0); },
    quiesce() { service.quiesce(); },
    stop() { service.quiesce(); },
    async dispose() { await service.close(); },
  };
}
