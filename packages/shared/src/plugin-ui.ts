/** UI contribution descriptors are wire metadata projected from the single
 * canonical package Manifest (H03); they are not a second package schema and
 * carry no executable code, callbacks, SQL, URLs or reflected class names.
 * Availability literals mirror the frozen @mote/plugin-api contract values so
 * TS and Kotlin decoders share the same identity, revision and failure codes. */
import type {FeatureRequirement} from './feature-packs.js';

export const pluginPlatforms = ['web', 'mac', 'android'] as const;
export type PluginPlatform = typeof pluginPlatforms[number];

export const uiContributionKinds = [
  'page', 'collection', 'reader', 'home', 'settings', 'command', 'quick-entry',
  'theme', 'layout', 'custom-page', 'declarative-view', 'native-service',
] as const;
export type UiContributionKind = typeof uiContributionKinds[number];

/** Mirrors the frozen contract: independent of installed/desired/verified and
 * of whether an upgrade requires a restart. OS grants are a separate fact and
 * never appear here. */
export const uiAvailabilityStates = ['active', 'unavailable', 'requires-build', 'unsupported', 'revoked', 'waiting-device'] as const;
export type UiAvailabilityState = typeof uiAvailabilityStates[number];
export const uiUnavailableReasons = [
  'dependency_unavailable', 'not_verified', 'requires_build', 'platform_unsupported',
  'waiting_device', 'revoked', 'permission_denied', 'conflict', 'stale_scope', 'internal',
] as const;
export type UiUnavailableReason = typeof uiUnavailableReasons[number];
export type UiAvailability =
  | {readonly state: 'active'}
  | {readonly state: Exclude<UiAvailabilityState, 'active'>; readonly reason: UiUnavailableReason};

/** What a contribution needs when its required native provider is absent.
 * A generic reader/essential-action fallback preserves readable material. */
export const nativeFallbacks = ['generic-reader', 'essential-actions', 'none'] as const;
export type NativeFallback = typeof nativeFallbacks[number];

export interface NativeRequirement {
  readonly capability: string;
  readonly apiVersion: string;
  readonly platforms: readonly PluginPlatform[];
  readonly optional?: boolean;
  readonly fallback: NativeFallback;
}

export interface UiContributionPresentation {
  /** i18n keys only; resolved at runtime against the plugin namespace. */
  readonly labelKey: string;
  readonly glyphKey?: string;
  readonly a11yKey?: string;
  readonly i18nNamespace: string;
}

export interface UiContributionCommand {
  readonly id: string;
  readonly apiVersion: string;
}

export const uiDraftScopes = ['owner', 'connection', 'plugin-instance', 'view'] as const;
export type UiDraftScope = typeof uiDraftScopes[number];

export interface UiContributionDescriptor {
  /** Opaque contribution identity within the declaring package; never parsed
   * as a surface:id prefix. Kind is a separate typed field. */
  readonly id: string;
  readonly kind: UiContributionKind;
  readonly apiVersion: string;
  readonly platforms: readonly PluginPlatform[];
  /** Service/contribution dependencies; host:'server' is checked by the
   * consuming UI against that connection's inventory. */
  readonly requires?: readonly FeatureRequirement[];
  readonly nativeRequires?: readonly NativeRequirement[];
  readonly presentation: UiContributionPresentation;
  readonly data?: {readonly schemaRef: string; readonly schemaVersion: number};
  readonly commands?: readonly UiContributionCommand[];
  /** Draft/return-ticket scope per the view-lifetime contract (U02). */
  readonly draftScope?: UiDraftScope;
}

export interface UiContributionRejection {
  readonly id: string;
  readonly reason: 'duplicate' | 'schema_incompatible' | 'untrusted_content';
}

/** Deterministic admission of one candidate against already-accepted
 * contributions. A duplicate or schema-incompatible candidate is rejected
 * whole; the existing shell and plugins are kept, registration order never
 * wins. `supportedDataVersions` maps a data schemaRef to the schemaVersions
 * this host build understands. */
export function acceptUiContribution(
  accepted: readonly UiContributionDescriptor[],
  candidate: UiContributionDescriptor,
  supportedDataVersions: Readonly<Record<string, readonly number[]>> = {},
): {readonly accepted: true} | {readonly accepted: false; readonly reason: UiContributionRejection['reason']} {
  for (const existing of accepted) if (existing.id === candidate.id) return {accepted: false, reason: 'duplicate'};
  if (candidate.data) {
    const versions = supportedDataVersions[candidate.data.schemaRef];
    if (versions && !versions.includes(candidate.data.schemaVersion)) return {accepted: false, reason: 'schema_incompatible'};
  }
  return {accepted: true};
}

/** Facts a host supplies at projection time. Grant/permission state is
 * deliberately absent: it is a separate authorization fact, not availability. */
export interface UiAvailabilityFacts {
  readonly requirementsAvailable: boolean;
  /** Capability ids of native providers actually registered for this platform build. */
  readonly registeredNativeCapabilities: ReadonlySet<string>;
  readonly revoked?: boolean;
  /** A bound device/provider is offline or absent from this host. */
  readonly deviceUnavailable?: boolean;
}

/** Projection pairing each unavailable state with exactly one canonical
 * reason; a missing required native provider is requires-build, never
 * 'unavailable' with a build reason. Checked in declaration order. */
export function uiContributionAvailability(
  descriptor: UiContributionDescriptor,
  platform: PluginPlatform,
  facts: UiAvailabilityFacts,
): UiAvailability {
  if (!descriptor.platforms.includes(platform)) return {state: 'unsupported', reason: 'platform_unsupported'};
  if (facts.revoked) return {state: 'revoked', reason: 'revoked'};
  if (!facts.requirementsAvailable) return {state: 'unavailable', reason: 'dependency_unavailable'};
  for (const requirement of descriptor.nativeRequires ?? []) {
    if (requirement.optional || !requirement.platforms.includes(platform)) continue;
    if (!facts.registeredNativeCapabilities.has(`${requirement.capability}@${requirement.apiVersion}`))
      return {state: 'requires-build', reason: 'requires_build'};
  }
  if (facts.deviceUnavailable) return {state: 'waiting-device', reason: 'waiting_device'};
  return {state: 'active'};
}

const MAX_CONTRIBUTION_FIELDS = 64;
const MAX_CONTRIBUTION_REQUIREMENTS = 64;
const isToken = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
const isApiVersion = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const allowed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));

function parseRequirement(input: unknown): NativeRequirement {
  if (!isPlain(input) || !allowed(input, ['capability', 'apiVersion', 'platforms', 'optional', 'fallback']))
    throw new TypeError('Invalid native requirement');
  if (!isToken(input.capability) || !isApiVersion(input.apiVersion)) throw new TypeError('Invalid native requirement identity');
  if (!Array.isArray(input.platforms) || input.platforms.length === 0 || !input.platforms.every(p => (pluginPlatforms as readonly string[]).includes(p)))
    throw new TypeError('Invalid native requirement platforms');
  if (!(nativeFallbacks as readonly string[]).includes(input.fallback as string)) throw new TypeError('Invalid native fallback');
  if (input.optional !== undefined && typeof input.optional !== 'boolean') throw new TypeError('Invalid native requirement flag');
  return input as unknown as NativeRequirement;
}

function parseDepends(input: unknown): FeatureRequirement {
  if (typeof input === 'string') return input;
  if (!isPlain(input) || !allowed(input, ['id', 'version', 'host'])) throw new TypeError('Invalid contribution requirement');
  if (!isToken(input.id) || !isToken(input.version)) throw new TypeError('Invalid contribution requirement identity');
  if (input.host !== undefined && input.host !== 'local' && input.host !== 'server') throw new TypeError('Invalid requirement host');
  return input as unknown as FeatureRequirement;
}

/** Strict wire parser for one contribution descriptor. Malformed or
 * executable-looking content (functions, accessors, extra keys) is rejected;
 * captured material resembling a descriptor is evidence, never code. */
export function parseUiContribution(input: unknown): UiContributionDescriptor {
  if (!isPlain(input) || Object.keys(input).length > MAX_CONTRIBUTION_FIELDS) throw new TypeError('Invalid contribution descriptor');
  const keys = ['id', 'kind', 'apiVersion', 'platforms', 'requires', 'nativeRequires', 'presentation', 'data', 'commands', 'draftScope'];
  if (!allowed(input, keys)) throw new TypeError('Contribution descriptor contains undeclared fields');
  if (!isToken(input.id) || !isApiVersion(input.apiVersion)) throw new TypeError('Invalid contribution identity');
  if (!(uiContributionKinds as readonly string[]).includes(input.kind as string)) throw new TypeError('Invalid contribution kind');
  if (!Array.isArray(input.platforms) || input.platforms.length === 0 || !input.platforms.every(p => (pluginPlatforms as readonly string[]).includes(p)))
    throw new TypeError('Invalid contribution platforms');
  const presentation = input.presentation;
  if (!isPlain(presentation) || !allowed(presentation, ['labelKey', 'glyphKey', 'a11yKey', 'i18nNamespace'])
    || !isToken(presentation.labelKey) || !isToken(presentation.i18nNamespace)
    || (presentation.glyphKey !== undefined && !isToken(presentation.glyphKey))
    || (presentation.a11yKey !== undefined && !isToken(presentation.a11yKey)))
    throw new TypeError('Invalid contribution presentation');
  if (input.requires !== undefined && (!Array.isArray(input.requires) || input.requires.length > MAX_CONTRIBUTION_REQUIREMENTS))
    throw new TypeError('Invalid contribution requirements');
  if (input.nativeRequires !== undefined && (!Array.isArray(input.nativeRequires) || input.nativeRequires.length > MAX_CONTRIBUTION_REQUIREMENTS))
    throw new TypeError('Invalid native requirements');
  if (input.commands !== undefined && (!Array.isArray(input.commands) || input.commands.length > MAX_CONTRIBUTION_REQUIREMENTS))
    throw new TypeError('Invalid contribution commands');
  if (input.data !== undefined) {
    if (!isPlain(input.data) || !allowed(input.data, ['schemaRef', 'schemaVersion'])
      || !isToken(input.data.schemaRef) || typeof input.data.schemaVersion !== 'number' || !Number.isSafeInteger(input.data.schemaVersion) || input.data.schemaVersion < 0)
      throw new TypeError('Invalid contribution data schema reference');
  }
  if (input.draftScope !== undefined && !(uiDraftScopes as readonly string[]).includes(input.draftScope as string))
    throw new TypeError('Invalid contribution draft scope');
  return {
    id: input.id, kind: input.kind as UiContributionKind, apiVersion: input.apiVersion,
    platforms: [...input.platforms] as PluginPlatform[],
    ...(input.requires !== undefined ? {requires: (input.requires as unknown[]).map(parseDepends)} : {}),
    ...(input.nativeRequires !== undefined ? {nativeRequires: (input.nativeRequires as unknown[]).map(parseRequirement)} : {}),
    presentation: {...(presentation as Record<string, unknown>)} as unknown as UiContributionPresentation,
    ...(input.data !== undefined ? {data: input.data as UiContributionDescriptor['data']} : {}),
    ...(input.commands !== undefined ? {commands: (input.commands as unknown[]).map(command => {
      if (!isPlain(command) || !allowed(command, ['id', 'apiVersion']) || !isToken(command.id) || !isApiVersion(command.apiVersion))
        throw new TypeError('Invalid contribution command');
      return command as unknown as UiContributionCommand;
    })} : {}),
    ...(input.draftScope !== undefined ? {draftScope: input.draftScope as UiDraftScope} : {}),
  };
}
