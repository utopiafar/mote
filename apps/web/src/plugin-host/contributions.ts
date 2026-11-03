/** Scope-owned plugin contributions for the Web host. A scope owns its
 * contributions, resources, disposers and mount outcome; one failed plugin
 * rolls back without touching siblings. Loader dispatch separates trusted
 * same-bundle React entries from external code, which may only mount through
 * an explicit isolated loader (U08) — an unisolated component is never a
 * mount. Mount lifecycle reuses the U02 ViewLifetime, never a second one. */
import { ViewLifetime } from '@mote/shared/plugin-view-lifetime';
import { contributionDescriptor, type WebContribution, type WebFeatureHost } from '../features/host';
import { customPageContributions, type CustomPageDeclaration, type CustomPageInstallation } from './custom-page-navigation';

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
  /** Manifest page contributions whose entry document runs isolated from the
   * trusted React bundle. Mounted through host-owned navigation entries. */
  readonly customPages?: readonly CustomPageDeclaration[];
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
  #customPages?: CustomPageInstallation;
  #mounted = false;

  constructor(host: WebFeatureHost, instance: InstanceSnapshot) {
    this.#host = host;
    this.instance = instance;
  }

  get mounted(): boolean { return this.#mounted; }
  get instanceId(): string { return this.instance.instanceId; }
  /** Host-owned custom page installation, including its live bridge mounts. */
  get customPages(): CustomPageInstallation | undefined { return this.#customPages; }

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
    // A custom page document is isolated by the host renderer, so no external
    // code enters the trusted bundle and no isolated loader is required for a
    // manifest page alone. Any other external contribution still needs one.
    if (inst.loader === 'external' && !isolated && !inst.customPages?.length) return { observed: 'skipped', reason: 'unsupported-loader' };
    try {
      if (inst.customPages?.length) {
        const installation = customPageContributions(inst, this.lifetime, inst.customPages);
        this.#customPages = installation;
        await this.install(installation.contributions);
        this.defer(() => installation.revoke());
      }
      if (inst.loader === 'react') await this.install(inst.contributions);
      else await isolated?.mount(this);
      this.#mounted = true;
      this.lifetime.show();
      return { observed: 'mounted' };
    } catch (cause) {
      await this.rollback();
      return { observed: 'failed', error: { pluginId: inst.packageId, instanceId: inst.instanceId, cause } };
    }
  }

  /** Install one scope-owned contribution set. The install returns its Cordis
   * fiber; disposing it on rollback actually withdraws the scope's
   * contributions from the registry. Builtin instances are declared 1:1 with
   * their package, so the manifest keeps the package ID — FeatureInventory
   * keeps grouping browser and server capabilities under one feature.
   * Non-builtin instances key registry ownership on instanceId and qualify
   * the descriptor KEY only: the public entry.id stays stable for catalog
   * matching, while local dependency references are rewritten to the
   * qualified descriptor IDs. */
  async install(contributions: readonly WebContribution[]): Promise<void> {
    const inst = this.instance;
    const builtin = inst.installationId.startsWith('builtin:');
    const idMap = new Map(contributions.map(c => {
      const d = contributionDescriptor(c);
      return [d.id, `${d.id.split(':')[0]}:${inst.instanceId}/${c.entry.id}`] as const;
    }));
    const qualified = builtin ? contributions : contributions.map(c => {
      // Page entries ARE the route: their public id becomes the qualified
      // key so navigation lists and page() resolves the same address.
      // View surfaces keep the declared id for catalog matching. Local
      // requirements rewrite to qualified ids; server deps never change.
      const requires = c.entry.requires?.map(r => typeof r === 'string' ? r : r.host !== 'server' && idMap.has(r.id) ? { ...r, id: idMap.get(r.id)! } : r);
      const id = c.surface === 'page' ? `${inst.instanceId}/${c.entry.id}` : c.entry.id;
      return { ...c, entry: { ...c.entry, id, ...(requires ? { requires } : {}) } } as WebContribution;
    });
    const qualifyId = builtin ? undefined : (id: string) => idMap.get(id) ?? id;
    const fiber = await this.#host.install({ id: builtin ? inst.packageId : inst.instanceId, version: '1', components: [] }, [...qualified], qualifyId);
    this.defer(() => fiber.dispose());
  }

  /** Revoke this scope's resources; sibling scopes are untouched. Async
   * cleanup is fully awaited — rollback completes only when resources,
   * including the install fiber, have finished releasing — and cleanup
   * failures are returned, not swallowed. */
  async rollback(): Promise<{ errors: unknown[] }> {
    const errors: unknown[] = [];
    for (const dispose of this.#disposers.splice(0)) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    this.#mounted = false;
    if (this.lifetime.state !== 'disposed') {
      try { this.lifetime.dispose(); } catch (error) { errors.push(error); }
    }
    return { errors };
  }
}
