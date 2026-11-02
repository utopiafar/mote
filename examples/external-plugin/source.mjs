import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';

/** A repository-external source connector loaded by the real Central connector registry.
 * It declares one namespaced external-push kind; it does not poll, scan a vault,
 * read credentials or call a model. */
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
  create() {
    return {
      status() {
        return {ready: true, sdkVersion, source: 'example.external-source'};
      },
      configure(host) {
        host.ownerRoute({
          method: 'GET',
          path: '/api/connectors/example-external-source/status',
          handler: () => ({ready: true, sdkVersion, source: 'example.external-source'}),
        });
      },
    };
  },
};
