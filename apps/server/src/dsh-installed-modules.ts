import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import type {ManifestDependency, PackageManifest} from '@mote/plugin-api';
import type {InstanceIdentity, ServiceBinding} from '@mote/plugin-api/contracts';
import {PluginHostError, type PluginHandle, type PluginHost} from '@mote/plugin-host';
import {runtimeModuleReferenceSchema, type RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {DshProfileError, readNativeDshManifest, nativeDshEntrySpecifier, type InstalledDshModule} from '@mote/agent/runtime/dsh';
import type {InstalledDshAuthority} from './dsh-native.js';

/** Metadata from an already verified immutable installation. This projection
 * reads JSON and checks public export targets; it never imports native code. */
export interface DshInstalledPackage {
  readonly manifest: PackageManifest;
  readonly directory: string;
  readonly artifactDigest: string;
  readonly instance: InstanceIdentity;
}
export interface DshInstalledProjection {
  readonly modules: readonly Omit<InstalledDshModule, 'grantedCapabilities'>[];
  readonly capabilities: readonly string[];
  /** Existing Host dependency admission handles requirements outside this
   * package's original native peers before an activation becomes usable. */
  readonly dependencies: readonly ManifestDependency[];
}

export async function projectInstalledDshModules(pkg: DshInstalledPackage): Promise<DshInstalledProjection> {
  try {
    if (pkg.manifest.runtime !== 'service' || pkg.instance.packageId !== pkg.manifest.id) throw new DshProfileError('dsh_module_unavailable');
    const contributions = (pkg.manifest.contributions ?? []).filter(contribution => contribution.surface === 'agent' && contribution.runtime === 'native');
    if (!contributions.length) throw new DshProfileError('dsh_module_unavailable');
    const native = await readNativeDshManifest(pkg.directory);
    const modules = contributions.map(contribution => {
      if (!contribution.entry) throw new DshProfileError('dsh_module_unavailable');
      const target = nativeDshEntrySpecifier(pkg.directory, './' + contribution.entry);
      // Public aliases are valid. Prefer the root, then stable lexical order;
      // equality is checked on the real file rather than path spelling.
      const subpath = Object.keys(native.exports).sort((left, right) => left === right ? 0 : left === '.' ? -1 : right === '.' ? 1 : left < right ? -1 : 1).find(subpath => {
        try { return nativeDshEntrySpecifier(pkg.directory, native.exports[subpath]!) === target; }
        catch { return false; }
      });
      if (!subpath) throw new DshProfileError('dsh_module_unavailable');
      const reference = runtimeModuleReferenceSchema.parse({contribution: {instance: pkg.instance, contributionId: contribution.id}, revision: 0, artifactDigest: pkg.artifactDigest, exportName: 'default'});
      return {reference, packageRoot: pkg.directory, packageName: native.name, packageVersion: native.version, subpath};
    });
    // Required peer contributions within this installation use exact immutable
    // references. Other required package/service/Host dependencies are admitted
    // by the installed Host activation, not by parsing a selection.
    const localPeer = (dependency: ManifestDependency) => dependency.kind === 'contribution' && contributions.some(contribution => contribution.id === dependency.id);
    return {capabilities: [...native.capabilities], dependencies: [...pkg.manifest.dependencies, ...contributions.flatMap(contribution => contribution.requires ?? [])].filter(dependency => !localPeer(dependency)), modules: modules.map((module, index) => ({...module, requires: [...pkg.manifest.dependencies, ...(contributions[index]!.requires ?? [])].filter(dependency => dependency.required !== false && localPeer(dependency)).map(dependency => {
      const peers = contributions.map((contribution, index) => ({contribution, module: modules[index]!})).filter(peer => peer.contribution.id === dependency.id && peer.contribution.version === dependency.version);
      if (peers.length !== 1) throw new DshProfileError('dsh_dependency_missing');
      return peers[0]!.module.reference;
    })}))};
  } catch (error) {
    if (error instanceof DshProfileError) throw error;
    throw new DshProfileError('dsh_module_unavailable');
  }
}

export function installedDshModule(projection: DshInstalledProjection, reference: RuntimeModuleReference) {
  const found = projection.modules.filter(module => isDeepStrictEqual(module.reference, reference));
  return found.length === 1 ? found[0] : undefined;
}

/** Owner-visible selection metadata. No private artifact path, activation ID or
 * grant is inferred from a checked installation. */
export function nativeDshCatalog(projection: DshInstalledProjection) {
  return projection.modules.map(module => ({reference: module.reference, packageName: module.packageName, packageVersion: module.packageVersion, requestedCapabilities: [...projection.capabilities]}));
}

export interface InstalledDshActivation {
  readonly signal: AbortSignal;
  module(reference: RuntimeModuleReference): InstalledDshAuthority | undefined;
  assertCurrent(): void;
  close(): Promise<void>;
}

/** The installed instance owns a real Host activation and dependency pins.
 * Original native entrypoints run only in the query SDK child after the owner
 * grant is validated; checking/activating metadata never executes them here. */
export async function activateInstalledDsh(input: {
  readonly host: PluginHost;
  readonly instance: InstanceIdentity;
  readonly projection: DshInstalledProjection;
  readonly required: readonly ServiceBinding[];
  readonly optional: readonly ServiceBinding[];
  readonly signal: AbortSignal;
  assertCurrent(): void;
}): Promise<InstalledDshActivation> {
  let handle: PluginHandle | undefined;
  const current = () => {
    input.signal.throwIfAborted(); input.assertCurrent(); handle?.signal.throwIfAborted();
    if (handle && !input.host.snapshot().contributions.some(contribution => contribution.identity.scope.activationId === handle!.identity.activationId && contribution.identity.scope.host.id === input.host.identity.id && contribution.availability.state === 'active')) throw new PluginHostError('stale_scope');
  };
  try {
    current();
    handle = await input.host.install({identity: {...input.instance, host: input.host.identity, activationId: randomUUID()},
      contributions: input.projection.modules.map(module => ({id: module.reference.contribution.contributionId, apiVersion: '1'})),
      requires: input.required, optional: input.optional, restartRequired: true,
      factory(context) {
        const aborted = () => {void handle?.close('disabled').catch(() => {});};
        input.signal.addEventListener('abort', aborted, {once: true});
        context.scope.defer(() => input.signal.removeEventListener('abort', aborted));
        return {prepare: current, start: current, quiesce() {}, stop() {}, dispose() {}};
      },
    });
    current();
    const owned = handle, signal = AbortSignal.any([input.signal, owned.signal]);
    return Object.freeze({signal, assertCurrent: current, close: () => owned.close('disabled'), module(reference: RuntimeModuleReference) {
      current(); const module = installedDshModule(input.projection, reference);
      return module ? {module, signal, assertCurrent: current} : undefined;
    }});
  } catch (error) {
    try {await handle?.close('disabled');}
    catch (cleanup) {throw new AggregateError([error, cleanup], 'Native installation admission and cleanup failed', {cause: error});}
    throw error;
  }
}
