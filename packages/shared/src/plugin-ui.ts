/** UI contribution descriptors are wire metadata projected from the single
 * canonical package Manifest (H03); they are not a second package schema and
 * carry no executable code, callbacks, SQL, URLs or reflected class names.
 * Availability types come from the frozen @mote/plugin-api contract so TS and
 * Kotlin decoders share the same identity, revision and failure codes. */
import type {Availability, HostKind, PluginErrorCode} from '@mote/plugin-api/contracts';
import type {FeatureRequirement} from './feature-packs.js';

/** Client platforms are the non-central host kinds of the frozen contract. */
export type PluginPlatform = Exclude<HostKind, 'central'>;
export const pluginPlatforms: readonly PluginPlatform[] = ['web', 'mac', 'android'];

export const uiContributionKinds = [
  'page', 'collection', 'reader', 'home', 'settings', 'command', 'quick-entry',
  'theme', 'layout', 'custom-page', 'declarative-view', 'native-service',
] as const;
export type UiContributionKind = typeof uiContributionKinds[number];

/** The frozen plugin-api Availability is the single contract: independent of
 * installed/desired/verified and of whether an upgrade requires a restart.
 * OS grants are a separate fact and never appear here. */
export type UiAvailability = Availability;
export type UiUnavailableReason = PluginErrorCode;

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

/** A contribution together with its declaring package identity. Contribution
 * ids are opaque within their package; identical ids in different packages
 * never conflict. */
export interface ScopedContribution {
  readonly packageId: string;
  readonly descriptor: UiContributionDescriptor;
}

export interface UiContributionRejection {
  readonly packageId: string;
  readonly id: string;
  /** Frozen failure codes: duplicate → conflict, incompatible → api_incompatible. */
  readonly reason: PluginErrorCode;
}

/** Deterministic admission of one candidate against already-accepted
 * contributions. A duplicate (same packageId + contribution id) or
 * schema-incompatible candidate is rejected whole; the existing shell and
 * plugins are kept, registration order never wins. `supportedDataVersions`
 * is the host's declared data-schema compatibility map: an absent schemaRef
 * or version is rejected, never defaulted to supported. */
export function acceptUiContribution(
  accepted: readonly ScopedContribution[],
  candidate: ScopedContribution,
  supportedDataVersions: Readonly<Record<string, readonly number[]>> = {},
): {readonly accepted: true} | {readonly accepted: false; readonly rejection: UiContributionRejection} {
  for (const existing of accepted)
    if (existing.packageId === candidate.packageId && existing.descriptor.id === candidate.descriptor.id)
      return {accepted: false, rejection: {packageId: candidate.packageId, id: candidate.descriptor.id, reason: 'conflict'}};
  const data = candidate.descriptor.data;
  if (data) {
    const versions = Object.hasOwn(supportedDataVersions, data.schemaRef) ? supportedDataVersions[data.schemaRef] : undefined;
    if (!versions?.includes(data.schemaVersion))
      return {accepted: false, rejection: {packageId: candidate.packageId, id: candidate.descriptor.id, reason: 'api_incompatible'}};
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
export const isToken = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
export const isApiVersion = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Own-property descriptors only: accessors are rejected before any value is
 * read, so validation never executes getter code. Mirrors the frozen
 * plugin-api contract parser's strict plain-data boundary. */
export function strictDataObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlain(input)) throw new TypeError('Invalid object');
  const properties = Object.getOwnPropertyDescriptors(input);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(properties)) {
    const descriptor = properties[key as string];
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor || !('value' in descriptor))
      throw new TypeError('Invalid object fields');
    result[key] = descriptor.value;
  }
  return result;
}

/** Plain arrays only: no subclass prototype, no accessor or sparse elements,
 * no user-overridden iteration members. */
export function strictDataArray(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum)
    throw new TypeError('Invalid array');
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(properties).length !== input.length + 1) throw new TypeError('Invalid array fields');
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = properties[String(index)];
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Invalid array element');
    result.push(descriptor.value);
  }
  return result;
}

function parseRequirement(input: unknown): NativeRequirement {
  const value = strictDataObject(input, ['capability', 'apiVersion', 'platforms', 'optional', 'fallback']);
  if (!isToken(value.capability) || !isApiVersion(value.apiVersion)) throw new TypeError('Invalid native requirement identity');
  const platforms = strictDataArray(value.platforms, 8);
  if (platforms.length === 0 || !platforms.every(p => (pluginPlatforms as readonly string[]).includes(p as string)))
    throw new TypeError('Invalid native requirement platforms');
  if (!(nativeFallbacks as readonly string[]).includes(value.fallback as string)) throw new TypeError('Invalid native fallback');
  if (value.optional !== undefined && typeof value.optional !== 'boolean') throw new TypeError('Invalid native requirement flag');
  return {
    capability: value.capability, apiVersion: value.apiVersion,
    platforms: platforms as PluginPlatform[], fallback: value.fallback as NativeRequirement['fallback'],
    ...(value.optional !== undefined ? {optional: value.optional as boolean} : {}),
  };
}

function parseDepends(input: unknown): FeatureRequirement {
  if (typeof input === 'string') {
    if (!isToken(input)) throw new TypeError('Invalid contribution requirement identity');
    return input;
  }
  const value = strictDataObject(input, ['id', 'version', 'host']);
  if (!isToken(value.id) || !isToken(value.version)) throw new TypeError('Invalid contribution requirement identity');
  if (value.host !== undefined && value.host !== 'local' && value.host !== 'server') throw new TypeError('Invalid requirement host');
  return value as unknown as FeatureRequirement;
}

/** Strict wire parser for one contribution descriptor. Malformed or
 * executable-looking content (functions, accessors, extra keys, non-plain
 * arrays) is rejected before any field value is read; captured material
 * resembling a descriptor is evidence, never code. */
export function parseUiContribution(input: unknown): UiContributionDescriptor {
  const value = strictDataObject(input, ['id', 'kind', 'apiVersion', 'platforms', 'requires', 'nativeRequires', 'presentation', 'data', 'commands', 'draftScope']);
  if (Object.keys(value).length > MAX_CONTRIBUTION_FIELDS) throw new TypeError('Invalid contribution descriptor');
  if (!isToken(value.id) || !isApiVersion(value.apiVersion)) throw new TypeError('Invalid contribution identity');
  if (!(uiContributionKinds as readonly string[]).includes(value.kind as string)) throw new TypeError('Invalid contribution kind');
  const platforms = strictDataArray(value.platforms, 8);
  if (platforms.length === 0 || !platforms.every(p => (pluginPlatforms as readonly string[]).includes(p as string)))
    throw new TypeError('Invalid contribution platforms');
  const presentation = strictDataObject(value.presentation, ['labelKey', 'glyphKey', 'a11yKey', 'i18nNamespace']);
  if (!isToken(presentation.labelKey) || !isToken(presentation.i18nNamespace)
    || (presentation.glyphKey !== undefined && !isToken(presentation.glyphKey))
    || (presentation.a11yKey !== undefined && !isToken(presentation.a11yKey)))
    throw new TypeError('Invalid contribution presentation');
  const result: UiContributionDescriptor = {
    id: value.id, kind: value.kind as UiContributionKind, apiVersion: value.apiVersion,
    platforms: platforms as PluginPlatform[],
    presentation: {
      labelKey: presentation.labelKey, i18nNamespace: presentation.i18nNamespace,
      ...(presentation.glyphKey !== undefined ? {glyphKey: presentation.glyphKey} : {}),
      ...(presentation.a11yKey !== undefined ? {a11yKey: presentation.a11yKey} : {}),
    },
  };
  if (value.requires !== undefined)
    (result as {requires?: FeatureRequirement[]}).requires = strictDataArray(value.requires, MAX_CONTRIBUTION_REQUIREMENTS).map(parseDepends);
  if (value.nativeRequires !== undefined)
    (result as {nativeRequires?: NativeRequirement[]}).nativeRequires = strictDataArray(value.nativeRequires, MAX_CONTRIBUTION_REQUIREMENTS).map(parseRequirement);
  if (value.commands !== undefined)
    (result as {commands?: UiContributionCommand[]}).commands = strictDataArray(value.commands, MAX_CONTRIBUTION_REQUIREMENTS).map(command => {
      const parsed = strictDataObject(command, ['id', 'apiVersion']);
      if (!isToken(parsed.id) || !isApiVersion(parsed.apiVersion)) throw new TypeError('Invalid contribution command');
      return parsed as unknown as UiContributionCommand;
    });
  if (value.data !== undefined) {
    const data = strictDataObject(value.data, ['schemaRef', 'schemaVersion']);
    if (!isToken(data.schemaRef) || typeof data.schemaVersion !== 'number' || !Number.isSafeInteger(data.schemaVersion) || data.schemaVersion < 0)
      throw new TypeError('Invalid contribution data schema reference');
    (result as {data?: UiContributionDescriptor['data']}).data = {schemaRef: data.schemaRef, schemaVersion: data.schemaVersion};
  }
  if (value.draftScope !== undefined) {
    if (!(uiDraftScopes as readonly string[]).includes(value.draftScope as string)) throw new TypeError('Invalid contribution draft scope');
    (result as {draftScope?: UiContributionDescriptor['draftScope']}).draftScope = value.draftScope as UiContributionDescriptor['draftScope'];
  }
  return result;
}
