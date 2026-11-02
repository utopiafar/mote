import {createHash} from 'node:crypto';
import {
  runtimeProfileSchema, runtimeProviderDescriptorSchema, runtimeTaskRequirementsSchema, runSelectionReceiptSchema,
  type RuntimeModuleReference, type RuntimeProfile, type RuntimeProviderDescriptor, type RuntimeSettings,
  type RuntimeSelectionErrorCode, type RuntimeTaskRequirements, type RunSelectionReceipt,
} from '@mote/shared/agent-runtimes';
import type {ModelProfile} from '@mote/shared/models';
import {runtimeService, type ModelSelection, type ResolvedRuntimeProfile} from './contracts.js';

/** Host-only launch values. Never accepted in RuntimeProfile, a public command or a receipt. */
export interface TrustedRuntimeLaunch {readonly executable?: string; readonly home?: string}
export interface RuntimeProfileConfiguration {
  readonly assembly: RuntimeProfile['assembly'];
  readonly allowedHostCapabilities: RuntimeProfile['allowedHostCapabilities'];
  readonly launch: TrustedRuntimeLaunch;
}
/** C03/A10 supply explicit revisions and model capability facts around the current ModelProfile.
 * connectionFingerprint includes local-login identity when applicable; this module never reads auth files. */
export interface ModelProfileInput {
  readonly profile: ModelProfile;
  readonly profileRevision: number;
  readonly modelRevision: number;
  readonly connectionFingerprint: string;
  readonly capabilities: {readonly tools: boolean; readonly images: boolean};
}
export interface ResolvedRunSelection {
  readonly receipt: RunSelectionReceipt;
  readonly runtime: ResolvedRuntimeProfile<RuntimeProfileConfiguration>;
  readonly model: ModelProfileInput;
  /** Exact A01 identity projection; obtaining a real model lease remains A09's responsibility. */
  readonly modelSelection: ModelSelection;
  /** Internal-only. Credentials/launch changes alter identity without serializing them publicly. */
  readonly runtimeFingerprint: string;
  readonly modelFingerprint: string;
  readonly fingerprint: string;
}
export class RuntimeSelectionError extends Error {
  constructor(readonly code: RuntimeSelectionErrorCode) { super(code); this.name = 'RuntimeSelectionError'; }
}
function parse<T>(read: () => T): T {
  try { return read(); } catch (error) {
    if (error instanceof RuntimeSelectionError) throw error;
    throw new RuntimeSelectionError('runtime_settings_invalid');
  }
}
function hash(value: unknown): string {
  return parse(() => createHash('sha256').update(JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw Error();
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  })).digest('hex'));
}
function detached<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy); return copy;
}
const exact = (left: unknown, right: unknown) => hash(left) === hash(right);

export interface RuntimeProfileReferenceInput {
  readonly profile: RuntimeProfile;
  readonly providers: readonly RuntimeProviderDescriptor[];
  readonly installedModules: readonly RuntimeModuleReference[];
  /** Configuration reference validation may inspect unavailable installed providers; new runs may not. */
  readonly requireAvailable?: boolean;
}
/** Validate references independently of any model or feature assignment. */
export function resolveRuntimeProfileReference(input: RuntimeProfileReferenceInput) {
  const profile = parse(() => runtimeProfileSchema.parse(input.profile));
  const providers = parse(() => input.providers.map(value => runtimeProviderDescriptorSchema.parse(value)));
  const candidates = providers.filter(value => value.id === profile.runtimeProviderId);
  if (!candidates.length) throw new RuntimeSelectionError('runtime_provider_missing');
  const matches = candidates.filter(value => {
    const {packageId, installationId, instanceId} = value.binding.provider.scope;
    return exact(profile.providerRef, {service: value.binding.service, revision: value.binding.revision,
      provider: {instance: {packageId, installationId, instanceId}, contributionId: value.binding.provider.contributionId}});
  });
  if (profile.providerRef.service.id !== runtimeService.id || profile.providerRef.service.apiVersion !== runtimeService.apiVersion || matches.length !== 1) throw new RuntimeSelectionError('runtime_binding_stale');
  const provider = matches[0]!;
  if (input.requireAvailable !== false && provider.availability.state !== 'active') throw new RuntimeSelectionError('runtime_provider_unavailable');
  const references = [...profile.assembly.packages, ...profile.assembly.hooks, ...(profile.assembly.factory ? [profile.assembly.factory] : [])];
  if (references.some(reference => !input.installedModules.some(installed => exact(reference, installed)))) throw new RuntimeSelectionError('runtime_module_unavailable');
  return detached({profile, provider});
}
export interface RuntimeSelectionInput extends Omit<RuntimeProfileReferenceInput, 'requireAvailable'> {
  readonly revision: number;
  readonly model: ModelProfileInput;
  readonly requirements: RuntimeTaskRequirements;
  readonly launch?: TrustedRuntimeLaunch;
}
/** Structural validation only: stored model profiles may still need configuration or credentials. */
export function validateRuntimeModelPair(input: RuntimeSelectionInput) {
  const {profile, provider} = resolveRuntimeProfileReference({...input, requireAvailable: false});
  const requirements = parse(() => runtimeTaskRequirementsSchema.parse(input.requirements));
  const model = input.model, settings = model.profile.settings;
  if (![model.profileRevision, model.modelRevision].every(value => Number.isSafeInteger(value) && value >= 0)) throw new RuntimeSelectionError('runtime_settings_invalid');
  if (typeof model.capabilities.tools !== 'boolean' || typeof model.capabilities.images !== 'boolean') throw new RuntimeSelectionError('runtime_settings_invalid');
  // Protocol describes this model's transport, never which runtime is selected.
  const transport = settings.protocol;
  if (!provider.capabilities.modelTransports.includes(transport)) throw new RuntimeSelectionError('incompatible_runtime_model');
  if (!provider.capabilities.taskKinds.includes(requirements.taskKind)) throw new RuntimeSelectionError('runtime_capability_missing');
  for (const capability of requirements.capabilities) {
    const modelSupports = capability === 'images' ? model.capabilities.images : model.capabilities.tools;
    if (!provider.capabilities[capability] || !modelSupports) {
      throw new RuntimeSelectionError('runtime_capability_missing');
    }
    if (!profile.allowedHostCapabilities.includes(capability)) throw new RuntimeSelectionError('runtime_capability_denied');
  }
  if (typeof model.connectionFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(model.connectionFingerprint)) throw new RuntimeSelectionError('runtime_settings_invalid');
  return {profile, provider, requirements};
}
/** Pure new-run selection: no registry mutation, model/process prepare, grants or configuration commit. */
export function resolveRunSelection(input: RuntimeSelectionInput): ResolvedRunSelection {
  const {profile, provider, requirements} = validateRuntimeModelPair(input);
  if (provider.availability.state !== 'active') throw new RuntimeSelectionError('runtime_provider_unavailable');
  const model = input.model, settings = model.profile.settings;
  if (!settings.model.trim()) throw new RuntimeSelectionError('model_not_configured');
  const transport = settings.protocol;
  const assemblyFingerprint = hash(profile.assembly);
  const launch = input.launch ?? {};
  // A runtime's configuration identity is independent of the model and task, and conversely.
  const runtimeFingerprint = hash({profile, capabilities: provider.capabilities, launch});
  const modelFingerprint = hash(model);
  const publicFields = {
    schemaVersion: 1 as const, revision: input.revision,
    runtimeProviderId: provider.id, runtimeProviderRevision: provider.binding.revision,
    runtimeProfileId: profile.id, runtimeProfileRevision: profile.revision,
    modelProfileId: model.profile.id, modelProfileRevision: model.profileRevision, modelRevision: model.modelRevision,
    modelProviderId: settings.provider, modelId: settings.model, transport,
    assemblyFingerprint, taskKind: requirements.taskKind,
  };
  const receipt = parse(() => runSelectionReceiptSchema.parse({...publicFields, selectionFingerprint: hash(publicFields)}));
  return detached({
    receipt, runtime: {binding: provider.binding, runtimeId: provider.id, profileId: profile.id, profileRevision: profile.revision,
      assemblyFingerprint, taskKind: requirements.taskKind, configuration: {assembly: profile.assembly, allowedHostCapabilities: profile.allowedHostCapabilities, launch}},
    model, modelSelection: {modelId: settings.model, modelRevision: model.modelRevision, profileId: model.profile.id,
      profileRevision: model.profileRevision, transport}, runtimeFingerprint, modelFingerprint,
    fingerprint: hash({runtimeFingerprint, modelFingerprint, taskKind: requirements.taskKind, capabilities: requirements.capabilities}),
  });
}

/** Explicit allowlist projection; never spread a local selection into an HTTP response or durable public receipt. */
export function publicRunSelection(selection: ResolvedRunSelection): RunSelectionReceipt {
  return runSelectionReceiptSchema.parse(selection.receipt);
}

/** New runs resolve from a committed snapshot; accepted runs keep the detached selection above.
 * Config prepare/activate/rollback belongs to A09/C03. Ordinary changes may drain old leases;
 * revoke/stop still invalidate current grants and the A01 final fence, even for an immutable selection. */
export type RuntimeSettingsSnapshot = {readonly revision: number; readonly value: RuntimeSettings};
