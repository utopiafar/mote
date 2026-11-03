import type {StateStore} from '../state.js';
import type {ScopeIdentity} from './identity.js';
import type {ServiceResolver} from './services.js';

export type Awaitable<T> = T | Promise<T>;
export type StopReason = 'disabled' | 'dependency_unavailable' | 'upgrade' | 'restart' | 'revoked' | 'uninstalled' | 'shutdown' | 'startup_failed';
export interface PluginScope {
  readonly identity: ScopeIdentity;
  /** Abort on actual scope revocation/stop; quiescing alone may allow accepted pinned work to drain. */
  readonly signal: AbortSignal;
  /** Sensitive calls/commits must still check their domain grant/transaction fence. This is not a grant. */
  assertCurrent(): void;
  /** Track resources immediately when acquired, including before prepare/start completes. */
  defer(dispose: () => Awaitable<void>): void;
}
export interface PluginContext {
  readonly scope: PluginScope;
  readonly services: ServiceResolver;
  /** Host-bound instance state. The host supplies the namespace identity; callers never pass one. */
  readonly state: StateStore;
}
/** Host stages contributions until start succeeds. Factory failure also disposes acquired scope resources. */
export type PluginFactory = (context: PluginContext) => Awaitable<PluginLifecycle>;
export interface PluginLifecycle {
  prepare(): Awaitable<void>;
  start(): Awaitable<void>;
  /** Stop new acquire/admissions/timers while already accepted fixed-version work may finish.
   * Ordinary configuration replacement alone must not abort those pinned leases. */
  quiesce(reason: StopReason): Awaitable<void>;
  /** Host revokes submission eligibility, then cancels/drains; keep dependencies alive until settled. */
  stop(reason: StopReason): Awaitable<void>;
  /** Idempotent reverse cleanup; failures stay observable, including after partial startup. */
  dispose(): Awaitable<void>;
}
/** Descriptor only: host execution policy, not proof that the plugin stopped or a sandbox guarantee. */
export type ReplacementPolicy = 'hot' | 'restart';
