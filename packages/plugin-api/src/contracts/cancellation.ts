import {pluginErrorCodes, type PluginFailure} from './errors.js';
import {object, oneOf, optional, schema, token} from './schema.js';

export interface CallContext {
  readonly signal: AbortSignal;
  readonly operationId?: string;
  /** Absolute deadline in Unix milliseconds; adapters preserve the original deadline across retries. */
  readonly deadline?: number;
}
export interface Cancellation {
  readonly kind: 'cancelled' | 'deadline_exceeded' | 'revoked' | 'scope_stopped';
  readonly operationId?: string;
}
export const pluginFailureSchema = schema<PluginFailure>((input, field) => object<PluginFailure>(input, field, {code: oneOf(pluginErrorCodes), operationId: optional(token)}));
export const cancellationSchema = schema<Cancellation>((input, field) => object<Cancellation>(input, field, {kind: oneOf(['cancelled', 'deadline_exceeded', 'revoked', 'scope_stopped']), operationId: optional(token)}));
