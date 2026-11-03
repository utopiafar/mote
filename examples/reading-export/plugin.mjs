/** SDK host entry for the reading export package.
 *
 * This is a second-level plugin: its only external dependency is the public
 * `example.reading-review.plan@1` service port. It imports no reading review
 * module. The runtime binding is optional after activation so already published
 * generic materials stay readable after the provider is uninstalled or
 * revoked. A binding that exists but names another API version fails in
 * `prepare`, before `start` publishes or activates anything.
 */
import {PLUGIN_SDK_VERSION} from '@mote/plugin-sdk';
import {createReadingExportService} from './domain.mjs';
import {
  readingExportPort, readingPlanPort,
  READING_EXPORT_API_VERSION, READING_EXPORT_PORT_ID, READING_PLAN_API_VERSION, READING_PLAN_PORT_ID,
} from './port.mjs';

export const sdkVersion = PLUGIN_SDK_VERSION;
export {READING_EXPORT_API_VERSION, READING_EXPORT_PORT_ID, READING_PLAN_API_VERSION, READING_PLAN_PORT_ID};

export class ReadingExportDependencyError extends Error {
  constructor(message, {binding, cause} = {}) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'ReadingExportDependencyError';
    this.code = 'reading_export_dependency_unavailable';
    this.dependency = Object.freeze({kind: 'service', id: READING_PLAN_PORT_ID, version: READING_PLAN_API_VERSION});
    this.offered = binding?.service
      ? Object.freeze({id: binding.service.id, apiVersion: binding.service.apiVersion})
      : null;
  }
}

const offeredBinding = binding => binding?.service
  ? `${binding.service.id}@${binding.service.apiVersion}`
  : 'no runtime binding';

/** Exact identity check used before `services.acquire` and before activation. */
export function assertReadingPlanBinding(binding) {
  if (!binding?.service || binding.service.id !== READING_PLAN_PORT_ID
    || binding.service.apiVersion !== READING_PLAN_API_VERSION) {
    throw new ReadingExportDependencyError(
      `Reading export requires service ${READING_PLAN_PORT_ID}@${READING_PLAN_API_VERSION}; `
      + `the host provided ${offeredBinding(binding)}.`,
      {binding},
    );
  }
  return binding;
}

export const readingExportContribution = Object.freeze({
  id: 'reading-export.archive',
  version: '1',
  surface: 'data',
  runtime: 'service',
  provides: [{
    kind: 'service',
    id: READING_EXPORT_PORT_ID,
    apiVersion: READING_EXPORT_API_VERSION,
    cardinality: 'single',
  }],
});

/** A caller that has a provider activation can pin its public binding without
 * importing the reading review package. */
export function readingPlanBinding(providerScope, revision = 0) {
  return Object.freeze({
    service: Object.freeze({id: READING_PLAN_PORT_ID, apiVersion: READING_PLAN_API_VERSION}),
    provider: Object.freeze({scope: providerScope, contributionId: 'reading-review.port'}),
    revision,
  });
}

export function createPlugin(context, options = {}) {
  if (!context?.state) throw Error('The Mote host did not provide instance state');
  const binding = options.binding ?? null;
  const intervalMs = options.intervalMs ?? 60_000;
  let lease;
  let source;
  let service;

  function sourcePort(currentLease) {
    return Object.freeze({
      async state() {
        currentLease.assertCurrent();
        return currentLease.value.state();
      },
    });
  }

  return {
    async prepare() {
      if (binding) {
        assertReadingPlanBinding(binding);
        try {
          lease = await context.services.acquire(readingPlanPort, binding);
        } catch (error) {
          throw new ReadingExportDependencyError(
            `Reading export could not acquire service ${READING_PLAN_PORT_ID}@${READING_PLAN_API_VERSION}: `
            + `${error?.code ?? 'dependency_unavailable'}.`,
            {binding, cause: error},
          );
        }
        try {
          assertReadingPlanBinding(lease.binding);
        } catch (error) {
          await lease.release();
          throw error;
        }
        context.scope.defer(() => lease.release());
        source = sourcePort(lease);
      }
      service = createReadingExportService({state: context.state, source, clock: options.clock});
      context.scope.defer(() => service.close());
      await service.load();
      if (!lease) {
        await service.markSourceUnavailable('dependency_missing');
        return;
      }
      const onAbort = () => { void service.markSourceUnavailable('provider_unavailable').catch(() => {}); };
      lease.signal.addEventListener('abort', onAbort, {once: true});
      context.scope.defer(() => lease.signal.removeEventListener('abort', onAbort));
    },
    start() {
      context.provide(readingExportContribution.id, readingExportPort, service.port, 0);
      if (source && options.background !== false)
        context.scope.every(intervalMs, () => service.tick());
    },
    quiesce: () => service?.quiesce(),
    stop: () => service?.quiesce(),
    dispose: () => service?.close(),
  };
}

export const factory = createPlugin;

export default Object.freeze({
  id: 'example.reading-export',
  sdkVersion,
  contribution: readingExportContribution,
  factory: createPlugin,
});
