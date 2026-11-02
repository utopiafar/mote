/** Scope-owned plugin contributions for the Web host. A scope owns its
 * contributions, resources, disposers and mount outcome; one failed plugin
 * rolls back without touching siblings. Loader dispatch separates trusted
 * same-bundle React entries from external code, which may only mount through
 * an explicit isolated loader (U08) — an unisolated component is never a
 * mount. Mount lifecycle reuses the U02 ViewLifetime, never a second one. */
import { ViewLifetime } from '@mote/shared/plugin-view-lifetime';
import type { WebContribution, WebFeatureHost } from '../features/host';

export type InstanceLoader = 'react' | 'external';

/** The control-plane facts for one installed plugin instance, projected from
 * the real installed/bound snapshot. desired is the control-plane intent;
 * observed is only reported after an actual successful mount. */
export interface InstanceSnapshot {
  readonly packageId: string;
  readonly installationId: string;
  readonly instanceId: string;
  readonly desired: 'active' | 'inactive' | 'uninstalled';
  readonly compatible: boolean;
  readonly loader: InstanceLoader;
  readonly contributions: readonly WebContribution[];
}

export type MountOutcome =
  | { readonly observed: 'mounted' }
  | { readonly observed: 'skipped'; readonly reason: 'not-desired' | 'incompatible' | 'unsupported-loader' }
  | { readonly observed: 'failed'; readonly error: { readonly pluginId: string; readonly instanceId: string; readonly cause: unknown } };

/** The explicit isolated-loader contract external packages must use. */
export interface IsolatedLoader {
  mount(scope: PluginContributionScope): unknown;
}

export class PluginContributionScope {
  readonly instance: InstanceSnapshot;
  readonly lifetime = new ViewLifetime();
  #host: WebFeatureHost;
  #disposers: (() => unknown)[] = [];
  #mounted = false;

  constructor(host: WebFeatureHost, instance: InstanceSnapshot) {
    this.#host = host;
    this.instance = instance;
  }

  get mounted(): boolean { return this.#mounted; }
  get instanceId(): string { return this.instance.instanceId; }

  /** Scope-owned resources; revoked on unmount/rollback. Disposers may be
   * asynchronous and are always awaited before rollback completes. */
  defer(dispose: () => unknown): void { this.#disposers.push(dispose); }

  /** Mount the instance's contributions. desired+compatible gates admission;
   * observed='mounted' is reported only after a real successful install. */
  async mount(isolated?: IsolatedLoader): Promise<MountOutcome> {
    const inst = this.instance;
    if (this.#mounted) return { observed: 'mounted' };
    if (inst.desired !== 'active') return { observed: 'skipped', reason: 'not-desired' };
    if (!inst.compatible) return { observed: 'skipped', reason: 'incompatible' };
    if (inst.loader === 'external' && !isolated) return { observed: 'skipped', reason: 'unsupported-loader' };
    try {
      if (inst.loader === 'react') {
        // The install returns its Cordis fiber; disposing it on rollback
        // actually withdraws the scope's contributions from the registry.
        // Registry ownership keys on the instance so two instances of one
        // package coexist; the package ID stays on the snapshot for reporting
        // and dependency semantics.
        const fiber = await this.#host.install({ id: inst.instanceId, version: '1', components: [] }, [...inst.contributions]);
        this.defer(() => fiber.dispose());
      } else await isolated!.mount(this);
      this.#mounted = true;
      this.lifetime.show();
      return { observed: 'mounted' };
    } catch (cause) {
      await this.rollback();
      return { observed: 'failed', error: { pluginId: inst.packageId, instanceId: inst.instanceId, cause } };
    }
  }

  /** Revoke this scope's resources; sibling scopes are untouched. Async
   * cleanup is fully awaited — rollback completes only when resources,
   * including the install fiber, have finished releasing. */
  async rollback(): Promise<void> {
    for (const dispose of this.#disposers.splice(0)) {
      try { await dispose(); } catch { /* cleanup continues */ }
    }
    this.#mounted = false;
    if (this.lifetime.state !== 'disposed') this.lifetime.dispose();
  }
}
