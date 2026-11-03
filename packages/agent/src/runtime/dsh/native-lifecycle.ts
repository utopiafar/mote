import type {Context, Plugin} from '@deepseek-ai/cordis';

export type NativeDshDisposer = () => void | Promise<void>;

type PackageContext = Pick<Context, 'plugin'>;
type HookOptions = Parameters<Context['on']>[2];
type HookContext = {
  on(event: string | symbol, listener: (...args: any[]) => any, options?: HookOptions): () => unknown;
};

export interface NativeDshPackageContribution {
  readonly id: string;
  readonly plugin: Plugin;
  readonly provides?: readonly string[];
}

export interface NativeDshHookContribution {
  readonly event: string | symbol;
  readonly listener: (...args: any[]) => any;
  readonly options?: HookOptions;
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
