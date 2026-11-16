import {isDeepStrictEqual} from 'node:util';
import type {RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {DshProfileError, readNativeDshManifest, type InstalledDshModule, type NativeDshAssemblyBinding} from '@mote/agent/runtime/dsh';
import {dshAssemblyReferences, dshInstanceKey, type DshConfiguration} from './dsh-configuration.js';

/** The installed Host scope supplies artifact paths and activation authority.
 * Installation/check supplies no native grant: that comes only from the owner. */
export interface InstalledDshAuthority {
  readonly module: Omit<InstalledDshModule, 'grantedCapabilities'>;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export type InstalledDshResolver = (reference: RuntimeModuleReference) => Promise<InstalledDshAuthority | undefined>;

/** A registry adapter can outlive an installed activation. Resolve fresh scopes
 * for every query, then pin those scopes until tool/output delivery has ended. */
export function nativeDshSource(configuration: DshConfiguration, modelProfileId: string, revision: number, resolve: InstalledDshResolver): (() => Promise<NativeDshAssemblyBinding>) | undefined {
  const configured = configuration.profiles.find(profile => profile.modelProfileId === modelProfileId);
  if (!configured) return undefined;
  const profile = structuredClone(configured);
  return async () => {
    const authorities: InstalledDshAuthority[] = [], installedModules: InstalledDshModule[] = [];
    const assertCurrent = () => { for (const authority of authorities) { authority.signal.throwIfAborted(); authority.assertCurrent(); } };
    for (const reference of dshAssemblyReferences(profile.assembly)) {
      const authority = await resolve(reference);
      if (!authority || !isDeepStrictEqual(authority.module.reference, reference)) throw new DshProfileError('dsh_module_unavailable');
      authorities.push(authority); assertCurrent();
      let manifest;
      try { manifest = await readNativeDshManifest(authority.module.packageRoot); }
      catch { throw new DshProfileError('dsh_module_unavailable'); }
      assertCurrent();
      const grant = profile.grants.find(grant => dshInstanceKey(grant.instance) === dshInstanceKey(reference.contribution.instance));
      if (!grant || manifest.name !== authority.module.packageName || manifest.version !== authority.module.packageVersion) throw new DshProfileError('dsh_module_unavailable');
      // Do not silently intersect a request or overbroad grant. A native package
      // shares one process/scope, so all its declared capabilities are required.
      if (manifest.capabilities.some(capability => !grant.capabilities.includes(capability)) || grant.capabilities.some(capability => !manifest.capabilities.includes(capability))) throw new DshProfileError('dsh_profile_invalid');
      installedModules.push({...structuredClone(authority.module), grantedCapabilities: [...grant.capabilities]});
    }
    assertCurrent();
    return {revision, assembly: structuredClone(profile.assembly), installedModules, signal: AbortSignal.any(authorities.map(authority => authority.signal)), assertCurrent};
  };
}
