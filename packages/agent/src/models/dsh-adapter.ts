import type {AgentOptions} from '../types.js';
import {AgentNotConfiguredError} from '../types.js';
import type {HostRunPort, ModelLease} from '../runtime/contracts.js';
import {modelConnection, validateModelOptions} from './provider-registry.js';
import {observeModelTransport} from './http-transport.js';

export const DSH_MODEL_ADAPTER_DESCRIPTOR = Object.freeze({id: 'mote.model.dsh', version: '1'});

/** Private model transport value, separate from the runtime profile and public receipt. */
export type DshModelAdapter = Omit<AgentOptions, 'reader' | 'codex' | 'runModel' | 'contextToolMode'>;

export function dshModelConfigured(options: DshModelAdapter): boolean {
  const local = options.allowUnauthenticatedLocal && options.baseUrl && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(options.baseUrl).hostname);
  return Boolean(options.model?.trim() && (options.apiKey?.trim() || local));
}

/** Bind every observable native send, including retries and image turns, to the
 * current Host run and exact model lease. The observer owns only its private
 * loopback endpoint; the Host continues to own the model lease itself. */
export function createDshModelAdapter(model: ModelLease<DshModelAdapter>, host: HostRunPort) {
  host.assertCurrent();
  model.assertCurrent();
  const value = structuredClone({...model.value, authorizeModelRequest: undefined});
  const authorize = model.value.authorizeModelRequest;
  validateModelOptions(value);
  if (!dshModelConfigured(value)) throw new AgentNotConfiguredError();
  let observer: Awaited<ReturnType<typeof observeModelTransport>> | undefined;
  return {
    descriptor: DSH_MODEL_ADAPTER_DESCRIPTOR,
    value,
    connection: modelConnection(value),
    async start() {
      observer ??= await observeModelTransport(async () => {
        host.assertCurrent();
        model.assertCurrent();
        await authorize?.();
        host.assertCurrent();
        model.assertCurrent();
      });
      return observer;
    },
    async dispose() { await observer?.close(); },
  };
}
