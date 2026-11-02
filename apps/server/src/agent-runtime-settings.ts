import {
  runtimeSettingsSchema, type RuntimeSettings, type RuntimeTaskRequirements, type RuntimeProviderDescriptor,
  type RuntimeModuleReference,
} from '@mote/shared/agent-runtimes';
import {MODEL_FEATURES, type ModelFeature, type ModelFeatureDefaults, type ModelFeatureModels} from '@mote/shared/models';
import {
  resolveRunSelection, resolveRuntimeProfileReference, validateRuntimeModelPair, RuntimeSelectionError,
  type ModelProfileInput, type ResolvedRunSelection, type RuntimeSelectionInput, type TrustedRuntimeLaunch,
} from '@mote/agent/runtime/profile';

/** Local inputs supplied by C03/A09, never query/config HTTP fields. No global ConfigService bag. */
export interface AgentRuntimeSettingsContext {
  readonly models: readonly ModelProfileInput[];
  readonly modelDefaults: ModelFeatureDefaults;
  readonly defaultModels?: ModelFeatureModels;
  readonly providers: readonly RuntimeProviderDescriptor[];
  readonly installedModules: readonly RuntimeModuleReference[];
  readonly requirements: Readonly<Record<ModelFeature, RuntimeTaskRequirements>>;
  /** Runtime profile IDs, not provider type IDs: instances/profiles do not share launch values implicitly. */
  readonly launches?: Readonly<Record<string, TrustedRuntimeLaunch>>;
}
function settings(raw: unknown): RuntimeSettings {
  try { return runtimeSettingsSchema.parse(raw); }
  catch { throw new RuntimeSelectionError('runtime_settings_invalid'); }
}
function selectionInput(snapshot: RuntimeSettings, feature: ModelFeature, context: AgentRuntimeSettingsContext): RuntimeSelectionInput {
  if (new Set(context.models.map(value => value.profile.id)).size !== context.models.length) throw new RuntimeSelectionError('runtime_settings_invalid');
  const profile = snapshot.profiles.find(value => value.id === snapshot.assignments[feature]);
  if (!profile) throw new RuntimeSelectionError('runtime_profile_missing');
  const model = context.models.find(value => value.profile.id === context.modelDefaults[feature]);
  if (!model) throw new RuntimeSelectionError('model_profile_missing');
  const override = context.defaultModels?.[feature];
  const selected = override === undefined ? model : {...model, profile: {...model.profile, settings: {...model.profile.settings, model: override}}};
  return {revision: snapshot.revision, profile, model: selected, providers: context.providers,
    installedModules: context.installedModules, requirements: context.requirements[feature],
    launch: context.launches?.[profile.id]};
}

/** Cross-domain reference/pairing validation on one proposed snapshot, with no effects or partial writes.
 * Also checks unassigned profiles' provider/module references. Availability is execution state, not
 * a reason to erase stored configuration. A09 still must successfully prepare before publishing it. */
export function validateAgentRuntimeSettings(raw: unknown, context: AgentRuntimeSettingsContext): RuntimeSettings {
  const snapshot = settings(raw);
  for (const feature of MODEL_FEATURES) validateRuntimeModelPair(selectionInput(snapshot, feature, context));
  for (const profile of snapshot.profiles) {
    resolveRuntimeProfileReference({profile, providers: context.providers, installedModules: context.installedModules, requireAvailable: false});
  }
  return snapshot;
}

/** Caller supplies the structured feature, never a keyword-derived dispatch decision. */
export function resolveFeatureRunSelection(raw: unknown, feature: ModelFeature, context: AgentRuntimeSettingsContext): ResolvedRunSelection {
  return resolveRunSelection(selectionInput(settings(raw), feature, context));
}

/** C03's ConfigurationDomain fixes this schema/domain before acquisition and returns detached snapshots.
 * Its global expectedRevision/CAS is separate from profile and ServiceBinding revisions. This module
 * implements no update/activation transaction: invalid references or failed prepare leave the old
 * committed configuration/generation unchanged; C03/A09 own that actual rollback and lease retirement.
 * Stop/revoke is a C04/A01 fence, not an ordinary config edit and not an exemption for old selections. */
export type AgentRuntimeSettingsSnapshot = {readonly revision: number; readonly value: RuntimeSettings};
