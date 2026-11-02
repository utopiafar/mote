import {parseContributionIdentity, type ContributionIdentity} from './identity.js';
import {apiVersion, integer, object, schema, token, type Parser} from './schema.js';

export interface ServiceRef { readonly id: string; readonly apiVersion: string }
/** Fixed selected provider, not a request to choose whichever implementation is currently first. */
export interface ServiceBinding {
  readonly service: ServiceRef;
  readonly provider: ContributionIdentity;
  /** This provider binding's implementation snapshot, not global inventory/config/command CAS revision. */
  readonly revision: number;
}
export const parseServiceRef: Parser<ServiceRef> = (input, field) => object(input, field, {id: token, apiVersion});
export const parseServiceBinding: Parser<ServiceBinding> = (input, field) => object(input, field, {service: parseServiceRef, provider: parseContributionIdentity, revision: integer});
export const serviceRefSchema = schema(parseServiceRef);
export const serviceBindingSchema = schema(parseServiceBinding);

declare const serviceType: unique symbol;
/** Invariant local type token; generic values/callbacks are never wire data. */
export interface ServiceContract<T> extends ServiceRef { readonly [serviceType]?: (value: T) => T }
export function serviceContract<T>(id: string, apiVersion: string): ServiceContract<T> {
  return Object.freeze(serviceRefSchema.parse({id, apiVersion}));
}
export interface ServiceLease<T> {
  readonly binding: ServiceBinding;
  readonly value: T;
  /** Revoked/stopped scope cancels this signal; ordinary configuration changes may drain the pin. */
  readonly signal: AbortSignal;
  /** Recheck this pinned lease's current authority, not equality with the newest configuration. */
  assertCurrent(): void;
  /** Idempotent release invalidates this lease (including assertCurrent/value use), not siblings/provider.
   * It does not assert remote rollback or release durable submitted-effect reconciliation references. */
  release(): Promise<void>;
}
export interface ServiceResolver {
  /** Host must match exact service/API/provider identity before returning a lease; no silent fallback. */
  acquire<T>(contract: ServiceContract<T>, binding: ServiceBinding, signal?: AbortSignal): Promise<ServiceLease<T>>;
}
