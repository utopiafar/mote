import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';

/** A repository-external source connector loaded by the real Central connector registry.
 * It declares one namespaced external-push kind; it does not poll, scan a vault,
 * read credentials or call a model. The host injects a bound `ctx.state`; this
 * plugin never supplies a package, installation or instance identity. */
export const sdkVersion = PLUGIN_SDK_VERSION;

export default {
  apiVersion: 1,
  id: 'example-external-source',
  statusKey: 'example-external-source',
  sourceKinds: [{
    kind: 'example.external-source',
    capabilities: {
      lifecycle: 'external-push',
      discovery: 'explicit-selection',
      listening: 'none',
      readOriginal: 'none',
      synchronization: 'push-only',
      externalWrite: false,
    },
  }],
  create(ctx) {
    if (!ctx.state) throw Error('The Central host did not provide instance state');
    let launches = 0;
    return {
      async init() {
        const current = await ctx.state.get('launches');
        launches = (typeof current?.value === 'number' ? current.value : 0) + 1;
        if (current) await ctx.state.compareAndSet('launches', current.revision, launches);
        else await ctx.state.compareAndSet('launches', null, launches);
      },
      status() {
        return {ready: true, sdkVersion, source: 'example.external-source', launches};
      },
      configure(host) {
        host.ownerRoute({
          method: 'GET',
          path: '/api/connectors/example-external-source/status',
          handler: () => ({ready: true, sdkVersion, source: 'example.external-source', launches}),
        });
      },
    };
  },
};
