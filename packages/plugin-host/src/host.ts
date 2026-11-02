import {Context, type Fiber} from '@deepseek-ai/cordis';
import {
  MAX_SNAPSHOT_CONTRIBUTIONS, hostIdentitySchema, scopeIdentitySchema, serviceRefSchema, serviceBindingSchema, pluginSnapshotSchema,
  type HostIdentity, type ScopeIdentity, type ServiceRef, type ServiceBinding, type ServiceContract, type ServiceLease,
  type ServiceResolver, type PluginScope, type PluginLifecycle, type PluginSnapshot, type StopReason, type Awaitable,
} from '@mote/plugin-api/contracts';
import {PluginHostError, PluginResourceScope} from './scope.js';

export interface HostScope extends PluginScope {
  run<T>(work: (signal: AbortSignal) => T | Promise<T>): Promise<T | undefined>;
  every(ms: number, work: (signal: AbortSignal) => unknown | Promise<unknown>): () => void;
  retire(dispose: () => Awaitable<void>): void;
}
export interface HostPluginContext {
  readonly scope: HostScope;
  readonly services: ServiceResolver;
  /** A declared contribution may publish several typed ports. Values remain in Cordis, never the snapshot. */
  provide<T>(contributionId: string, contract: ServiceContract<T>, value: T, revision?: number): ServiceBinding;
}
/** Executable input from a resolved activation plan, not another wire/package Manifest. */
export interface PluginDefinition {
  readonly identity: ScopeIdentity;
  readonly contributions: readonly ServiceRef[];
  readonly requires?: readonly ServiceBinding[];
  readonly optional?: readonly ServiceBinding[];
  readonly restartRequired?: boolean;
  readonly factory: (context: HostPluginContext) => Awaitable<PluginLifecycle>;
}
export interface PluginHandle {
  readonly identity: ScopeIdentity;
  readonly signal: AbortSignal;
  quiesce(reason?: StopReason): Promise<void>;
  close(reason?: StopReason): Promise<void>;
}
type Phase = 'preparing' | 'active' | 'quiescing' | 'stopping';
interface Runtime {
  readonly identity: ScopeIdentity;
  readonly declarations: readonly ServiceRef[];
  readonly requires: readonly ServiceBinding[];
  readonly optional: readonly ServiceBinding[];
  readonly restartRequired: boolean;
  readonly resources: PluginResourceScope;
  phase: Phase;
  initialized: Promise<void>;
  context?: Context;
  fiber?: Fiber;
  lifecycle?: PluginLifecycle;
  quiescing?: Promise<void>;
  teardown?: Promise<void>;
  closing?: Promise<void>;
}
interface PublishedPort { readonly owner: Runtime; readonly binding: ServiceBinding; readonly key: string }
const scopeKey = (identity: ScopeIdentity) => JSON.stringify(identity);
const portKey = (binding: ServiceBinding) => JSON.stringify([binding.provider, binding.service.id]);
const bindingKey = (binding: ServiceBinding) => JSON.stringify(binding);
const reject = (code: ConstructorParameters<typeof PluginHostError>[0]): never => { throw new PluginHostError(code); };
function pinIdentity(identity: ScopeIdentity) {
  return Object.freeze({...identity, host: Object.freeze({...identity.host})});
}
function pinBinding(binding: ServiceBinding): ServiceBinding {
  return Object.freeze({...binding, service: Object.freeze({...binding.service}), provider: Object.freeze({...binding.provider, scope: pinIdentity(binding.provider.scope)})});
}
function closingTask(publish: (task: Promise<void>) => void, work: () => Promise<void>) {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const task = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  publish(task);
  void work().then(resolve, reject);
  return task;
}

/** Cordis owns every actual service implementation. Maps here contain only activation/binding metadata. */
export class PluginHost implements ServiceResolver {
  readonly context: Context;
  readonly identity: HostIdentity;
  private readonly ownsRoot: boolean;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly ports = new Map<string, PublishedPort>();
  private revision = 0;
  private closing?: Promise<void>;
  constructor(identity: HostIdentity, context?: Context, private readonly onError: (error: unknown) => void = () => {}) {
    this.identity = Object.freeze(hostIdentitySchema.parse(identity));
    this.context = context ?? new Context();
    this.ownsRoot = !context;
  }
  async install(definition: PluginDefinition): Promise<PluginHandle> {
    if (this.closing) return reject('stale_scope');
    const identity = pinIdentity(scopeIdentitySchema.parse(definition.identity)), key = scopeKey(identity);
    if (identity.host.id !== this.identity.id || identity.host.kind !== this.identity.kind) return reject('invalid_contract');
    if (this.runtimes.has(key)) return reject('conflict');
    const declarations = definition.contributions.map(value => Object.freeze(serviceRefSchema.parse(value)));
    if (new Set(declarations.map(value => value.id)).size !== declarations.length) return reject('conflict');
    const count = [...this.runtimes.values()].reduce((sum, runtime) => sum + runtime.declarations.length, declarations.length);
    if (count > MAX_SNAPSHOT_CONTRIBUTIONS) return reject('invalid_contract');
    const requires = (definition.requires ?? []).map(value => pinBinding(serviceBindingSchema.parse(value)));
    const optional = (definition.optional ?? []).map(value => pinBinding(serviceBindingSchema.parse(value)));
    const factory = definition.factory;
    for (const binding of requires) this.available(binding, true);
    const runtime: Runtime = {identity, declarations, requires, optional, restartRequired: definition.restartRequired ?? false,
      resources: new PluginResourceScope(this.onError), phase: 'preparing', initialized: Promise.resolve()};
    this.runtimes.set(key, runtime); this.revision++;
    try {
      const fiber = this.context.plugin((context: Context) => {
        runtime.context = context;
        // Join our cleanup explicitly; Cordis may otherwise log effect cleanup failures.
        context.effect(() => () => this.teardown(runtime, 'shutdown'));
        runtime.initialized = runtime.resources.run(() => this.initialize(runtime, factory)).then(() => {});
        return runtime.initialized;
      });
      runtime.fiber = fiber;
      await fiber;
      runtime.resources.assertCurrent();
      if (runtime.phase !== 'preparing') return reject('stale_scope');
      runtime.phase = 'active'; this.revision++;
      return Object.freeze({identity, signal: runtime.resources.signal,
        quiesce: (reason: StopReason = 'upgrade') => this.quiesce(runtime, reason),
        close: (reason: StopReason = 'disabled') => this.stop(runtime, reason)});
    } catch (error) {
      try { await this.stop(runtime, 'startup_failed'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Plugin startup and disposal failed', {cause: error}); }
      throw error;
    }
  }
  private async initialize(runtime: Runtime, factory: PluginDefinition['factory']) {
    const resources = runtime.resources;
    const assertCurrent = () => {
      resources.assertCurrent();
      if (runtime.phase === 'stopping' || runtime.context?.fiber.uid === null) return reject('stale_scope');
    };
    const scope: HostScope = Object.freeze({identity: runtime.identity, signal: resources.signal, assertCurrent,
      defer: resources.defer.bind(resources), retire: resources.retire.bind(resources), run: resources.run.bind(resources), every: resources.every.bind(resources)});
    const services: ServiceResolver = {acquire: <T>(contract: ServiceContract<T>, raw: ServiceBinding, signal?: AbortSignal) => {
      const binding = serviceBindingSchema.parse(raw);
      if (![...runtime.requires, ...runtime.optional].some(required => bindingKey(required) === bindingKey(binding))) return Promise.reject(new PluginHostError('permission_denied'));
      if (!resources.active) return Promise.reject(new PluginHostError('dependency_unavailable'));
      return this.acquirePort(contract, binding, signal, runtime);
    }};
    runtime.lifecycle = await factory(Object.freeze({scope, services,
      provide: <T>(id: string, contract: ServiceContract<T>, value: T, revision = 0) => {
        assertCurrent();
        const declaration = runtime.declarations.find(declaration => declaration.id === id), service = serviceRefSchema.parse(contract);
        if (!resources.active || !declaration) return reject('invalid_contract');
        if (declaration.apiVersion !== service.apiVersion) return reject('api_incompatible');
        const binding = pinBinding(serviceBindingSchema.parse({service, provider: {scope: runtime.identity, contributionId: id}, revision}));
        const name = portKey(binding);
        if (this.ports.has(name)) return reject('conflict');
        const key = 'motePluginPort:' + name;
        const dispose = runtime.context!.provide(key, value);
        const port = {owner: runtime, binding, key}; this.ports.set(name, port); this.revision++;
        resources.retire(async () => { try { await dispose(); } finally { if (this.ports.get(name) === port) { this.ports.delete(name); this.revision++; } } });
        return binding;
      }}));
    assertCurrent();
    await runtime.lifecycle.prepare();
    assertCurrent();
    if (runtime.phase !== 'preparing') return reject('stale_scope');
    await runtime.lifecycle.start();
    assertCurrent();
    if (runtime.phase !== 'preparing') return reject('stale_scope');
  }
  private available(binding: ServiceBinding, admission: boolean) {
    const port = this.ports.get(portKey(binding));
    if (!port || port.owner.context?.fiber.uid === null) return reject('dependency_unavailable');
    if (port.binding.service.apiVersion !== binding.service.apiVersion) return reject('api_incompatible');
    if (port.binding.revision !== binding.revision) return reject('conflict');
    if (port.owner.resources.signal.aborted || port.owner.phase === 'stopping') return reject('stale_scope');
    if (port.owner.phase !== 'active' && (admission || port.owner.phase !== 'quiescing')) return reject('dependency_unavailable');
    return port;
  }
  async acquire<T>(contract: ServiceContract<T>, raw: ServiceBinding, signal?: AbortSignal) {
    return this.acquirePort(contract, serviceBindingSchema.parse(raw), signal);
  }
  private async acquirePort<T>(contract: ServiceContract<T>, binding: ServiceBinding, signal?: AbortSignal, consumer?: Runtime): Promise<ServiceLease<T>> {
    if (this.closing) return reject('stale_scope');
    const ref = serviceRefSchema.parse(contract);
    if (ref.id !== binding.service.id || ref.apiVersion !== binding.service.apiVersion) return reject('api_incompatible');
    const port = this.available(binding, true), releaseController = new AbortController();
    const signals = [port.owner.resources.signal, releaseController.signal, ...(consumer ? [consumer.resources.signal] : []), ...(signal ? [signal] : [])];
    const leaseSignal = AbortSignal.any(signals);
    let released = false;
    const assertCurrent = () => {
      if (released || this.closing || consumer?.resources.signal.aborted) return reject('stale_scope');
      this.available(binding, false);
      if (signal?.aborted) return reject('cancelled');
    };
    assertCurrent();
    const actual = port.owner.context!.get(port.key) as T;
    if (actual === undefined) return reject('dependency_unavailable');
    const invoke = (callback: Function, receiver: unknown, args: unknown[]) => {
      assertCurrent();
      const value = Reflect.apply(callback, receiver, args);
      if (value && typeof value.then === 'function') {
        const pending = Promise.resolve(value).then(result => { assertCurrent(); return result; });
        port.owner.resources.join(pending); consumer?.resources.join(pending);
        return pending;
      }
      return value;
    };
    // A facade also supports frozen port objects; no proxy invariants of the implementation are changed.
    const members = new Map<PropertyKey, {source: Function; guarded: Function}>();
    const read = (property: PropertyKey): unknown => {
      assertCurrent(); const member = Reflect.get(actual as object, property, actual);
      if (typeof member !== 'function') return member;
      let cached = members.get(property);
      if (!cached || cached.source !== member) { cached = {source: member, guarded: (...args: unknown[]) => invoke(member, actual, args)}; members.set(property, cached); }
      return cached.guarded;
    };
    const guarded = typeof actual === 'function' ? ((...args: unknown[]) => invoke(actual, undefined, args)) :
      actual && typeof actual === 'object' ? new Proxy({}, {get: (_target, property) => {
        return read(property);
      }, has: (_target, property) => { assertCurrent(); return property in actual; },
      set: (_target, property, value) => { assertCurrent(); return Reflect.set(actual, property, value, actual); },
      ownKeys: () => { assertCurrent(); return Reflect.ownKeys(actual); },
      getOwnPropertyDescriptor: (_target, property) => { assertCurrent(); const descriptor = Object.getOwnPropertyDescriptor(actual, property); return descriptor ? {enumerable: descriptor.enumerable ?? false, configurable: true, get: () => read(property)} : undefined; }}) : actual;
    let releasing: Promise<void> | undefined;
    const lease: ServiceLease<T> = {binding: pinBinding(binding), signal: leaseSignal, assertCurrent,
      get value() { assertCurrent(); return guarded as T; },
      release() { released = true; releaseController.abort(new PluginHostError('stale_scope')); return releasing ??= Promise.resolve(); }};
    consumer?.resources.defer(() => lease.release());
    return Object.freeze(lease);
  }
  private quiesce(runtime: Runtime, reason: StopReason) {
    if (runtime.phase === 'stopping') return Promise.reject(new PluginHostError('stale_scope'));
    for (const target of this.requiredGraph(runtime)) {
      if (target.phase === 'stopping') return Promise.reject(new PluginHostError('stale_scope'));
      target.resources.quiesce(); target.phase = 'quiescing';
    }
    this.revision++;
    return this.quiesceHooks(runtime, reason);
  }
  private dependents(runtime: Runtime) {
    return [...this.runtimes.values()].filter(candidate => candidate !== runtime && candidate.requires.some(binding => scopeKey(binding.provider.scope) === scopeKey(runtime.identity)));
  }
  private requiredGraph(runtime: Runtime) {
    const affected = new Set<Runtime>([runtime]);
    for (const provider of affected) for (const candidate of this.dependents(provider)) affected.add(candidate);
    return affected;
  }
  private quiesceHooks(runtime: Runtime, reason: StopReason): Promise<void> {
    if (runtime.quiescing) return runtime.quiescing;
    return closingTask(task => { runtime.quiescing = task; }, async () => {
      const results = await Promise.allSettled(this.dependents(runtime).map(dependent => this.quiesceHooks(dependent, reason)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      try { await runtime.initialized; await runtime.lifecycle?.quiesce(reason); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Plugin quiesce failed');
    });
  }
  private teardown(runtime: Runtime, reason: StopReason) {
    if (runtime.teardown) return runtime.teardown;
    return closingTask(task => { runtime.teardown = task; }, async () => {
      this.revokeGraph(runtime, reason);
      const errors: unknown[] = [];
      const attempt = async (work: () => unknown | Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
      // Required consumers stop while their provider's resources and registrations still exist.
      const dependents = this.dependents(runtime);
      const results = await Promise.allSettled(dependents.map(dependent => this.stop(dependent, 'dependency_unavailable')));
      errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      await runtime.initialized.catch(() => {}); // Startup failure is retained by install(), not duplicated as cleanup.
      if (runtime.lifecycle) {
        await attempt(() => runtime.quiescing ?? runtime.lifecycle!.quiesce(reason));
        await attempt(() => runtime.lifecycle!.stop(reason));
        await attempt(() => runtime.resources.drain());
        await attempt(() => runtime.lifecycle!.dispose());
      }
      await attempt(() => runtime.resources.close());
      this.runtimes.delete(scopeKey(runtime.identity)); this.revision++;
      if (errors.length) throw new AggregateError(errors, 'Plugin disposal failed');
    });
  }
  /** Fence the complete required graph synchronously, before any slow hook can block a sibling. */
  private revokeGraph(runtime: Runtime, reason: StopReason) {
    const affected = this.requiredGraph(runtime);
    for (const target of affected) { target.phase = 'stopping'; target.resources.quiesce(); }
    for (const target of affected) target.resources.stop(new PluginHostError(reason === 'revoked' ? 'revoked' : 'stale_scope'));
    this.revision++;
  }
  private stop(runtime: Runtime, reason: StopReason) {
    const graceful = reason === 'upgrade' || reason === 'restart';
    if (runtime.closing) {
      if (!graceful) this.revokeGraph(runtime, reason);
      return runtime.closing;
    }
    return closingTask(task => { runtime.closing = task; }, async () => {
      const errors: unknown[] = [];
      if (graceful) {
        try { await this.quiesce(runtime, reason); } catch (error) { errors.push(error); }
        await Promise.all([...this.requiredGraph(runtime)].map(target => target.resources.drain()));
      }
      try { await this.teardown(runtime, reason); } catch (error) { errors.push(error); }
      try { await runtime.fiber?.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Plugin disposal failed');
    });
  }
  snapshot(): PluginSnapshot {
    return pluginSnapshotSchema.parse({schemaVersion: 1, host: this.identity, revision: this.revision,
      contributions: [...this.runtimes.values()].flatMap(runtime => runtime.declarations.map(declaration => ({
        identity: {scope: runtime.identity, contributionId: declaration.id}, apiVersion: declaration.apiVersion, restartRequired: runtime.restartRequired,
        availability: runtime.phase === 'active' && runtime.context?.fiber.uid !== null ? {state: 'active'} :
          runtime.phase === 'stopping' ? {state: 'revoked', reason: 'stale_scope'} : {state: 'unavailable', reason: 'dependency_unavailable'},
      })))});
  }
  close() {
    if (this.closing) return this.closing;
    const runtimes = [...this.runtimes.values()];
    return closingTask(task => { this.closing = task; }, async () => {
      // Revoke immediately before yielding, including scopes whose startup is still in flight.
      for (const runtime of runtimes) { runtime.phase = 'stopping'; runtime.resources.quiesce(); }
      for (const runtime of runtimes) runtime.resources.stop();
      const results = await Promise.allSettled(runtimes.map(runtime => this.stop(runtime, 'shutdown')));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (this.ownsRoot) try { await this.context.fiber.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Plugin host disposal failed');
    });
  }
}
