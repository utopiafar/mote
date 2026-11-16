import {isDeepStrictEqual} from 'node:util';
import type {RuntimeModuleReference} from '@mote/shared/agent-runtimes';
import {DshProfileError, readNativeDshManifest, type InstalledDshModule, type NativeDshAssemblyBinding} from '@mote/agent/runtime/dsh';
import {RuntimeSelectionError} from '@mote/agent/runtime/profile';
import {dshAssemblyReferences, dshInstanceKey, type DshConfiguration} from './dsh-configuration.js';
import {StoreError} from './store.js';
import type {StateStore} from '@mote/plugin-api';
import type {QueryInput} from '@mote/agent';
import {openNativeApplication} from './dsh-application.js';
import type {Store} from './store.js';
import {nativeOutputPublisher} from './dsh-native-outputs.js';
import type {SourceStore} from './sources.js';
import type {ArchivedFileStore} from './archived-files.js';

/** The installed Host scope supplies artifact paths and activation authority.
 * Installation/check supplies no native grant: that comes only from the owner. */
export interface InstalledDshAuthority {
  readonly module: Omit<InstalledDshModule, 'grantedCapabilities'>;
  readonly signal: AbortSignal;
  readonly applicationState?:StateStore;
  assertCurrent(): void;
}
export type InstalledDshResolver = (reference: RuntimeModuleReference) => Promise<InstalledDshAuthority | undefined>;

export async function validateNativeDshGrant(module: Omit<InstalledDshModule, 'grantedCapabilities'>, grants: DshConfiguration['profiles'][number]['grants']): Promise<InstalledDshModule> {
  let manifest;
  try { manifest = await readNativeDshManifest(module.packageRoot); }
  catch { throw new DshProfileError('dsh_module_unavailable'); }
  const grant = grants.find(grant => dshInstanceKey(grant.instance) === dshInstanceKey(module.reference.contribution.instance));
  if (!grant || manifest.name !== module.packageName || manifest.version !== module.packageVersion) throw new DshProfileError('dsh_module_unavailable');
  // A native package shares one process/scope. Do not silently intersect an
  // incomplete request or an overbroad grant with the original declarations.
  if (manifest.capabilities.some(capability => !grant.capabilities.includes(capability)) || grant.capabilities.some(capability => !manifest.capabilities.includes(capability))) throw new DshProfileError('dsh_profile_invalid');
  return {...structuredClone(module), grantedCapabilities: [...grant.capabilities]};
}

const selectionCodes = new Set(['runtime_settings_invalid', 'runtime_profile_missing', 'runtime_provider_missing', 'runtime_provider_unavailable', 'runtime_binding_stale', 'runtime_module_unavailable', 'runtime_capability_missing', 'runtime_capability_denied', 'incompatible_runtime_model']);
const nativeSelectionCodes = new Set(['dsh_profile_invalid', 'dsh_module_unavailable', 'dsh_dependency_missing', 'dsh_factory_duplicate']);
/** Only known selection failures are a configuration conflict. Provider errors,
 * arbitrary native exceptions and existing HTTP/storage failures stay primary. */
export async function dshSelectionBoundary<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (!(error instanceof DshProfileError && nativeSelectionCodes.has(error.code)) && !(error instanceof RuntimeSelectionError && selectionCodes.has(error.code))) throw error;
    const failure = new StoreError('The selected native DSH installation or grant is unavailable', 409); failure.cause = error; throw failure;
  }
}

/** A registry adapter can outlive an installed activation. Resolve fresh scopes
 * for every query, then pin those scopes until tool/output delivery has ended. */
export function nativeDshSource(configuration: DshConfiguration, modelProfileId: string, revision: number, resolve: InstalledDshResolver,applicationServices?:{store:Store;sources:SourceStore;archivedFiles:ArchivedFileStore}): ((input?:QueryInput) => Promise<NativeDshAssemblyBinding>) | undefined {
  const configured = configuration.profiles.find(profile => profile.modelProfileId === modelProfileId);
  if (!configured) return undefined;
  const profile = structuredClone(configured);
  return async (input) => {
    const authorities: InstalledDshAuthority[] = [], installedModules: InstalledDshModule[] = [];
    const assertCurrent = () => { for (const authority of authorities) { authority.signal.throwIfAborted(); authority.assertCurrent(); } };
    for (const reference of dshAssemblyReferences(profile.assembly)) {
      const authority = await resolve(reference);
      if (!authority || !isDeepStrictEqual(authority.module.reference, reference)) throw new DshProfileError('dsh_module_unavailable');
      authorities.push(authority); assertCurrent();
      const module = await validateNativeDshGrant(authority.module, profile.grants);
      assertCurrent();
      installedModules.push(module);
    }
    assertCurrent();
    const context=profile.application&&input?.nativeApplicationContext?.();
    if(profile.application&&input&&!context&&input.executionLane==='interactive'&&!input.taskContext&&(!input.responseMode||input.responseMode==='answer'))throw new StoreError('Native application interactions require an admitted conversation message',409);
    const primary=profile.application&&authorities.find(authority=>dshInstanceKey(authority.module.reference.contribution.instance)===dshInstanceKey(profile.application!.instance));
    if(context&&(!applicationServices||!primary?.applicationState))throw new StoreError('Native application persistence is unavailable',409);
    const application=context&&openNativeApplication({store:applicationServices!.store,state:primary!.applicationState!,profile,context,assertCurrent,publish:nativeOutputPublisher(applicationServices!.sources,applicationServices!.archivedFiles)});
    return {revision, assembly: structuredClone(profile.assembly), installedModules, signal: AbortSignal.any(authorities.map(authority => authority.signal)), assertCurrent,...(application?{application}:{})};
  };
}
