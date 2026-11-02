/** Real Web plugin bootstrap: consume the installed/bound snapshot and drive
 * each instance through the same scope-owned install/mount path — builtin
 * packages and external ones alike. Only desired+compatible instances mount;
 * observed status comes back from the actual mount result. When the control
 * plane does not yet expose instance-level fields, callers must pass the real
 * snapshot — this module never fabricates one. */
import type { WebFeatureHost } from '../features/host';
import { PluginContributionScope, type InstanceSnapshot, type IsolatedLoader, type MountOutcome } from './contributions';

export interface BootstrapReport {
  readonly packageId: string;
  readonly instanceId: string;
  readonly outcome: MountOutcome;
}

export interface BootstrapResult {
  readonly reports: readonly BootstrapReport[];
  readonly scopes: ReadonlyMap<string, PluginContributionScope>;
}

/** Drive the real instance snapshots through scope-owned mounts. Each scope
 * is created before its mount so a failed mount rolls back only that scope. */
export async function bootstrapPlugins(
  host: WebFeatureHost,
  instances: readonly InstanceSnapshot[],
  options: { readonly isolatedLoaders?: ReadonlyMap<string, IsolatedLoader> } = {},
): Promise<BootstrapResult> {
  const reports: BootstrapReport[] = [];
  const scopes = new Map<string, PluginContributionScope>();
  for (const instance of instances) {
    const scope = new PluginContributionScope(host, instance);
    scopes.set(instance.instanceId, scope);
    const outcome = await scope.mount(options.isolatedLoaders?.get(instance.instanceId));
    reports.push({ packageId: instance.packageId, instanceId: instance.instanceId, outcome });
  }
  return { reports, scopes };
}

/** Application teardown: roll back every owned scope so contributions,
 * deferred resources and view lifetimes release through the same contract a
 * failed mount uses. */
export async function teardownPlugins(scopes: ReadonlyMap<string, PluginContributionScope>): Promise<{ errors: unknown[] }> {
  const errors: unknown[] = [];
  for (const scope of scopes.values()) {
    try {
      const result = await scope.rollback();
      errors.push(...result.errors);
    } catch (error) { errors.push(error); }
  }
  return { errors };
}

/** A builtin instance declares its own snapshot: it is installed with this
 * build, desired-active, and trusted to run in the same React bundle. */
export function builtinInstance(packageId: string, contributions: InstanceSnapshot['contributions']): InstanceSnapshot {
  return { packageId, installationId: `builtin:${packageId}`, instanceId: `builtin:${packageId}`, desired: 'active', compatible: true, loader: 'react', contributions };
}
