import type {Context, Plugin} from '@deepseek-ai/cordis';

export type NativeDshDisposer = () => void | Promise<void>;
export type NativeDshReplacement = 'hot' | 'restart';

export interface NativeDshContributionDescriptor {
  readonly id: string;
  readonly version: string;
  readonly replacement: NativeDshReplacement;
}

type PackageContext = Pick<Context, 'plugin'>;
type HookOptions = Parameters<Context['on']>[2];
type HookContext = {
  on(event: string | symbol, listener: (...args: any[]) => any, options?: HookOptions): () => unknown;
};

export interface NativeDshPackageContribution {
  readonly id: string;
  readonly plugin: Plugin;
  readonly provides?: readonly string[];
  /** Base loop packages use restart; business tool packages stay hot. */
  readonly descriptor?: NativeDshContributionDescriptor;
}

export interface NativeDshHookContribution {
  readonly event: string | symbol;
  readonly listener: (...args: any[]) => any;
  readonly options?: HookOptions;
  readonly descriptor?: NativeDshContributionDescriptor;
}

export interface NativeDshFactoryRegistry<Factory> {
  setFactory(factory: Factory): () => unknown;
}

export type NativeDshLifecycleContext<Factory> = PackageContext & HookContext & {
  readonly agents: NativeDshFactoryRegistry<Factory>;
};

export interface NativeDshGeneration<Factory> {
  readonly packages?: readonly NativeDshPackageContribution[];
  readonly hooks?: readonly NativeDshHookContribution[];
  readonly factory?: Factory;
  readonly factoryDescriptor?: NativeDshContributionDescriptor;
  /** Explicitly forces a restart even when no descriptor identifies the changed foundation. */
  readonly restartRequired?: boolean;
}

export async function registerNativeDshPackage(
  ctx: PackageContext,
  contribution: NativeDshPackageContribution,
): Promise<NativeDshDisposer> {
  const fiber = ctx.plugin(contribution.plugin);
  await fiber;
  return () => fiber.dispose();
}

export function registerNativeDshHook(
  ctx: HookContext,
  contribution: NativeDshHookContribution,
): NativeDshDisposer {
  const dispose = ctx.on(contribution.event, contribution.listener, contribution.options);
  return async () => { await dispose(); };
}

export function registerNativeDshFactory<Factory>(
  ctx: {readonly agents: NativeDshFactoryRegistry<Factory>},
  factory: Factory,
): NativeDshDisposer {
  const dispose = ctx.agents.setFactory(factory);
  return async () => { await dispose(); };
}

function injectedServices(plugin: Plugin): readonly string[] {
  const inject = (plugin as {readonly inject?: readonly string[] | Record<string, unknown> | null}).inject;
  if (!inject) return [];
  return Array.isArray(inject) ? inject : Object.keys(inject);
}

function packageOrder(packages: readonly NativeDshPackageContribution[]): readonly number[] {
  const providers = new Map<string, number>();
  packages.forEach((contribution, index) => {
    for (const service of contribution.provides ?? []) providers.set(service, index);
  });
  const dependencies = packages.map(contribution => injectedServices(contribution.plugin)
    .map(service => providers.get(service))
    .filter((index): index is number => index !== undefined));
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const order: number[] = [];
  const visit = (index: number) => {
    if (visited.has(index)) return;
    if (visiting.has(index)) throw new Error(`Native DSH package inject cycle involves ${packages[index]!.id}`);
    visiting.add(index);
    for (const dependency of dependencies[index]!) visit(dependency);
    visiting.delete(index);
    visited.add(index);
    order.push(index);
  };
  packages.forEach((_, index) => visit(index));
  return order;
}

function collectDisposer(disposers: NativeDshDisposer[]): NativeDshDisposer {
  let closing: Promise<void> | undefined;
  return () => closing ??= (async () => {
    const errors: unknown[] = [];
    while (disposers.length) {
      try { await disposers.pop()!(); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Native DSH generation disposal failed');
  })();
}

/** Stage a complete generation. A failed candidate disposes only its own registrations. */
export async function loadNativeDshGeneration<Factory>(
  ctx: NativeDshLifecycleContext<Factory>,
  candidate: NativeDshGeneration<Factory>,
): Promise<NativeDshDisposer> {
  const packages = candidate.packages ?? [];
  const order = packageOrder(packages);
  const disposers: NativeDshDisposer[] = [];
  const dispose = collectDisposer(disposers);
  try {
    for (const index of order) disposers.push(await registerNativeDshPackage(ctx, packages[index]!));
    for (const contribution of candidate.hooks ?? []) disposers.push(registerNativeDshHook(ctx, contribution));
    if (candidate.factory !== undefined) disposers.push(registerNativeDshFactory(ctx, candidate.factory));
    return dispose;
  } catch (primary) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], 'Native DSH candidate and rollback failed', {cause: primary}); }
    throw primary;
  }
}

function descriptorKey(value: NativeDshContributionDescriptor | undefined): string {
  return value === undefined ? '' : `${value.id}@${value.version}:${value.replacement}`;
}

function generationParts<Factory>(generation: NativeDshGeneration<Factory>) {
  const restart = (descriptor: NativeDshContributionDescriptor | undefined) => descriptor?.replacement === 'restart';
  const foundation: NativeDshGeneration<Factory> = {
    packages: (generation.packages ?? []).filter(contribution => restart(contribution.descriptor)),
    hooks: (generation.hooks ?? []).filter(contribution => restart(contribution.descriptor)),
    ...(generation.factory === undefined ? {} : {factory: generation.factory}),
    ...(generation.factoryDescriptor === undefined ? {} : {factoryDescriptor: generation.factoryDescriptor}),
  };
  const hot: NativeDshGeneration<Factory> = {
    packages: (generation.packages ?? []).filter(contribution => !restart(contribution.descriptor)),
    hooks: (generation.hooks ?? []).filter(contribution => !restart(contribution.descriptor)),
  };
  return {foundation, hot};
}

function hasFoundation<Factory>(generation: NativeDshGeneration<Factory>): boolean {
  return generation.factory !== undefined || generation.factoryDescriptor !== undefined ||
    Boolean(generation.packages?.length || generation.hooks?.length);
}

function foundationKeys<Factory>(generation: NativeDshGeneration<Factory>): readonly string[] {
  return [
    ...(generation.packages ?? []).map(contribution => `package:${descriptorKey(contribution.descriptor)}`),
    ...(generation.hooks ?? []).map(contribution => `hook:${String(contribution.event)}:${descriptorKey(contribution.descriptor)}`),
  ].sort();
}

function sameFoundation<Factory>(current: NativeDshGeneration<Factory>, next: NativeDshGeneration<Factory>): boolean {
  const before = generationParts(current).foundation, after = generationParts(next).foundation;
  if (before.factory !== after.factory || descriptorKey(before.factoryDescriptor) !== descriptorKey(after.factoryDescriptor)) return false;
  const left = foundationKeys(before), right = foundationKeys(after);
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Base loop and factory changes need a fresh runtime start; tool/hook-only changes stay hot.
 * A candidate that carries only business extensions inherits the active foundation. */
export function nativeDshRequiresRestart<Factory>(
  current: NativeDshGeneration<Factory> | undefined,
  next: NativeDshGeneration<Factory>,
): boolean {
  if (current === undefined) return false;
  if (next.restartRequired === true) return true;
  const nextFoundation = generationParts(next).foundation;
  return hasFoundation(nextFoundation) && !sameFoundation(current, next);
}

function runIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const agent = (value as {readonly agent?: {readonly id?: unknown}}).agent;
  if (agent && typeof agent.id === 'string') return agent.id;
  const sessionId = (value as {readonly sessionId?: unknown}).sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

interface NativeDshToolRegistry {
  schemas(): readonly {readonly name: string}[];
  guard(guard: (exec: {readonly name: string; readonly agent?: {readonly id?: string}}) => string | undefined): () => unknown;
}

function toolRegistry(ctx: NativeDshLifecycleContext<unknown>): NativeDshToolRegistry | undefined {
  const tools = (ctx as {readonly tools?: Partial<NativeDshToolRegistry>}).tools;
  return tools && typeof tools.schemas === 'function' && typeof tools.guard === 'function' ? tools as NativeDshToolRegistry : undefined;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

export type NativeDshGenerationState = 'ready' | 'restart-required' | 'failed';

export interface NativeDshGenerationStatus {
  readonly state: NativeDshGenerationState;
  readonly generation: number;
  readonly activeRuns: number;
  readonly restartRequired: boolean;
  readonly cause?: unknown;
}

export interface NativeDshRunLease {
  readonly runId: string;
  readonly generation: number;
  release(): Promise<void>;
}

export interface NativeDshGenerationRegistryOptions {
  /** Disposal is asynchronous after a hot switch; observation cannot change the result. */
  readonly onDisposeError?: (error: unknown) => void;
}

interface LoadedGeneration<Factory> {
  readonly id: number;
  readonly candidate: NativeDshGeneration<Factory>;
  readonly dispose: NativeDshDisposer;
  readonly runs: Set<string>;
  readonly idle: Promise<void>;
  resolveIdle: () => void;
  retired: boolean;
  closing?: Promise<void>;
}

interface LoadedFoundation<Factory> {
  readonly generation: NativeDshGeneration<Factory>;
  readonly dispose: NativeDshDisposer;
}

/** Owns hot generations and their run leases. A retired generation waits for its last run. */
export class NativeDshGenerationRegistry<Factory> {
  private readonly generations = new Set<LoadedGeneration<Factory>>();
  private readonly runs = new Map<string, LoadedGeneration<Factory>>();
  private readonly tasks = new Set<Promise<NativeDshGenerationStatus>>();
  private readonly toolGenerations = new Map<string, number>();
  private readonly tools: NativeDshToolRegistry | undefined;
  private guardDispose: (() => unknown) | undefined;
  private foundation?: LoadedFoundation<Factory>;
  private current?: LoadedGeneration<Factory>;
  private installing?: number;
  private nextGeneration = 0;
  private closing?: Promise<void>;

  constructor(
    private readonly ctx: NativeDshLifecycleContext<Factory>,
    private readonly options: NativeDshGenerationRegistryOptions = {},
  ) {
    this.tools = toolRegistry(ctx as NativeDshLifecycleContext<unknown>);
    this.guardDispose = this.tools?.guard(exec => {
      const runId = runIdFrom(exec), owner = runId === undefined ? this.current?.id : this.runs.get(runId)?.id;
      const toolOwner = this.toolGenerations.get(exec.name);
      return owner !== undefined && toolOwner !== undefined && toolOwner !== owner
        ? 'The tool belongs to another native generation' : undefined;
    });
  }

  get generation(): number { return this.current?.id ?? 0; }
  get activeRuns(): number { return this.runs.size; }

  /** Lease the current generation for one run. Hooks are dispatched only to that run's generation. */
  beginRun(runId: string): NativeDshRunLease {
    if (this.closing) throw new Error('Native DSH generation registry is closed');
    if (!runId) throw new Error('A native DSH run identity is required');
    const generation = this.current;
    if (!generation) throw new Error('No native DSH generation is active');
    if (this.runs.has(runId)) throw new Error(`Native DSH run ${runId} already owns a generation lease`);
    generation.runs.add(runId); this.runs.set(runId, generation);
    let released: Promise<void> | undefined;
    const registry = this;
    return Object.freeze({runId, generation: generation.id, release() {
      return released ??= (async () => {
        if (registry.runs.get(runId) !== generation) return;
        registry.runs.delete(runId); generation.runs.delete(runId);
        if (!generation.runs.size) generation.resolveIdle();
        if (generation.retired) await registry.retire(generation);
      })();
    }});
  }

  replace(candidate: NativeDshGeneration<Factory>): Promise<NativeDshGenerationStatus> {
    if (this.closing) return Promise.resolve(this.status('failed', this.current, new Error('Native DSH generation registry is closed')));
    const task = this.doReplace(candidate);
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await Promise.allSettled([...this.tasks]);
      const results = await Promise.allSettled([...this.generations].map(generation => this.retire(generation)));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      const foundation = this.foundation; this.foundation = undefined;
      try { await foundation?.dispose(); }
      catch (error) { errors.push(error); }
      const guard = this.guardDispose; this.guardDispose = undefined;
      try { await guard?.(); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Native DSH generation disposal failed');
    })();
    return this.closing;
  }

  private async doReplace(candidate: NativeDshGeneration<Factory>): Promise<NativeDshGenerationStatus> {
    const active = this.current, parts = generationParts(candidate);
    const addsFoundation = hasFoundation(parts.foundation);
    if (active && (nativeDshRequiresRestart(active.candidate, candidate) || addsFoundation && !this.foundation)) {
      return this.status('restart-required', active);
    }
    const id = ++this.nextGeneration;
    let beforeTools = new Set(this.tools?.schemas().map(tool => tool.name) ?? []);
    let foundation: LoadedFoundation<Factory> | undefined, dispose: NativeDshDisposer | undefined;
    try {
      if (!this.foundation && addsFoundation) {
        foundation = {generation: parts.foundation, dispose: await loadNativeDshGeneration(this.ctx, parts.foundation)};
        beforeTools = new Set(this.tools?.schemas().map(tool => tool.name) ?? []);
      }
      this.installing = id;
      dispose = await loadNativeDshGeneration(this.ctx, this.gateHooks(parts.hot, id));
    } catch (cause) {
      if (foundation) await Promise.resolve(foundation.dispose()).catch(() => {});
      return this.status('failed', active, cause);
    } finally {
      this.installing = undefined;
    }
    if (this.closing || dispose === undefined) {
      try { await dispose?.(); await foundation?.dispose(); }
      catch (cause) { return this.status('failed', active, cause); }
      return this.status('failed', active, new Error('Native DSH generation registry is closed'));
    }
    if (foundation) this.foundation = foundation;
    if (this.tools) for (const tool of this.tools.schemas()) {
      if (!beforeTools.has(tool.name)) this.toolGenerations.set(tool.name, id);
    }
    const idle = deferred();
    const loaded: LoadedGeneration<Factory> = {id, candidate, dispose, runs: new Set(), idle: idle.promise,
      resolveIdle: idle.resolve, retired: false};
    this.generations.add(loaded); this.current = loaded;
    if (active) {
      active.retired = true;
      // The outgoing generation remains registered until its last in-flight run releases.
      void this.retire(active).catch(error => { this.options.onDisposeError?.(error); });
    }
    return this.status('ready', loaded);
  }

  private gateHooks(candidate: NativeDshGeneration<Factory>, generation: number): NativeDshGeneration<Factory> {
    const registry = this;
    const hooks = candidate.hooks?.map(contribution => ({
      ...contribution,
      listener: function(this: unknown, ...args: any[]) {
        const runId = runIdFrom(args[0]);
        const owner = runId === undefined ? registry.current?.id ?? registry.installing : registry.runs.get(runId)?.id;
        const next = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
        if (owner !== generation) return next ? Reflect.apply(next, this, []) : undefined;
        return Reflect.apply(contribution.listener, this, args);
      },
    }));
    return hooks === undefined ? candidate : {...candidate, hooks};
  }

  private retire(generation: LoadedGeneration<Factory>): Promise<void> {
    generation.retired = true;
    return generation.closing ??= (async () => {
      if (generation.runs.size) await generation.idle;
      this.generations.delete(generation);
      if (this.current === generation) this.current = undefined;
      await generation.dispose();
      for (const [name, id] of this.toolGenerations) if (id === generation.id) this.toolGenerations.delete(name);
    })();
  }

  private status(state: NativeDshGenerationState, generation: LoadedGeneration<Factory> | undefined, cause?: unknown): NativeDshGenerationStatus {
    return {state, generation: generation?.id ?? 0, activeRuns: this.runs.size, restartRequired: state === 'restart-required',
      ...(cause === undefined ? {} : {cause})};
  }
}
