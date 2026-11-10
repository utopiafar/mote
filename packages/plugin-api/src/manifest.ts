import {
  apiVersion, array, boolean, invalid, object, oneOf, optional, schema, token, version,
  type Parser,
} from './contracts/schema.js';

/** The one current package descriptor. Release source/digest identity stays
 * outside the descriptor in the resolver; this type never contains code,
 * credentials or host file paths. */
export const PACKAGE_MANIFEST_VERSION = 1 as const;

export const contributionSurfaces = [
  'ingress', 'upload', 'data', 'command', 'agent', 'processing', 'page', 'collection',
  'card', 'action', 'renderer', 'panel', 'settings', 'home', 'theme', 'layout',
] as const;
export type ContributionSurface = typeof contributionSurfaces[number];

/** A host is the client/process that activates a contribution. An execution
 * location says where the contribution actually runs; they are different
 * facts. */
export const runtimeLocations = ['worker', 'service', 'host', 'native'] as const;
export type RuntimeLocation = typeof runtimeLocations[number];

export const trustLevels = ['official', 'external'] as const;
export type TrustLevel = typeof trustLevels[number];

export const dependencyKinds = ['package', 'service', 'contribution', 'host'] as const;
export type DependencyKind = typeof dependencyKinds[number];

export const providerKinds = ['service', 'collection', 'chain'] as const;
export type ProviderKind = typeof providerKinds[number];

export const providerCardinalities = ['single', 'collection', 'ordered'] as const;
export type ProviderCardinality = typeof providerCardinalities[number];

export type ManifestJsonValue = null | boolean | number | string | readonly ManifestJsonValue[] |
  {readonly [key: string]: ManifestJsonValue};
export interface ManifestJsonObject { readonly [key: string]: ManifestJsonValue }

export interface ManifestDependency {
  readonly kind: DependencyKind;
  readonly id: string;
  /** Exact identity; API/package ranges are not negotiated here. */
  readonly version: string;
  readonly required?: boolean;
}

export interface ManifestProvider {
  readonly kind: ProviderKind;
  readonly id: string;
  readonly apiVersion: string;
  readonly cardinality: ProviderCardinality;
}

export interface ManifestContribution {
  readonly id: string;
  readonly version: string;
  readonly surface: ContributionSurface;
  readonly runtime: RuntimeLocation;
  /** Relative package path for an executable contribution; host/page
   * contributions may omit it. */
  readonly entry?: string;
  readonly requires?: readonly ManifestDependency[];
  readonly provides?: readonly ManifestProvider[];
  /** Package-level capability IDs this contribution actually provides. */
  readonly capabilities?: readonly string[];
}

export interface ManifestConfigurationField {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'number' | 'boolean' | 'select' | 'model-profile' | 'secret-reference';
  readonly required?: boolean;
  readonly options?: {readonly value: string; readonly label: string}[];
  readonly description?: string;
}

/** Declarative source-directory card. The host projects this after install;
 * OAuth and first sync stay in Sources, not in Plugin Center. */
export interface ManifestSourceCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly note: string;
  /** Host glyph token (for example lucide icon id); never a remote URL. */
  readonly icon: string;
  readonly kinds: readonly string[];
  readonly target: {readonly pageId: string; readonly href: string};
  readonly setupChoiceId?: string;
  /** Existing account binding key a new kind may attach to without re-OAuth. */
  readonly attachToBinding?: string;
}

/** Current unique package Manifest. `contributions` is the single source of
 * feature/native/UI projection; `FeatureManifest` is a derived browser view,
 * not a second package authority. `actionCapabilities` is an opaque domain
 * declaration validated by its owning domain handler, not by the host. */
export interface PackageManifest {
  readonly schemaVersion: typeof PACKAGE_MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly trust?: TrustLevel;
  /** Host execution location for `entry`; contributions may run elsewhere. */
  readonly runtime: 'worker' | 'service';
  readonly entry: string;
  readonly archive: {readonly asset: string; readonly sha256: string};
  readonly contributions?: readonly ManifestContribution[];
  /** Package-level capability summary retained for the current control plane.
   * Feature surfaces come from `contributions`, never from this list. */
  readonly capabilities: readonly string[];
  readonly actionCapabilities?: readonly ManifestJsonObject[];
  readonly configuration: ManifestConfigurationField[];
  readonly dependencies: readonly ManifestDependency[];
  readonly access: readonly string[];
  readonly sourceCatalog?: readonly ManifestSourceCatalogEntry[];
}

const displayText: Parser<string> = (input, field) =>
  typeof input === 'string' && input.length > 0 && input.length <= 512 && !/[\r\n\0]/.test(input) ? input : invalid(field);
const relativePath: Parser<string> = (input, field) => {
  if (typeof input !== 'string' || !input || input.startsWith('/') || input.includes('\\') ||
    input.split('/').some(part => !part || part === '.' || part === '..')) return invalid(field);
  return input;
};
const manifestId: Parser<string> = (input, field) =>
  typeof input === 'string' && /^[a-z][a-z0-9.-]{2,127}$/.test(input) ? input : invalid(field);
const archiveAsset: Parser<string> = (input, field) =>
  typeof input === 'string' && /^[^/\\]+\.zip$/.test(input) ? input : invalid(field);
const sha256: Parser<string> = (input, field) =>
  typeof input === 'string' && /^[a-f0-9]{64}$/.test(input) ? input : invalid(field);
const configurationType = oneOf(['text', 'number', 'boolean', 'select', 'model-profile', 'secret-reference']);

const parseDependency: Parser<ManifestDependency> = (input, field) => object<ManifestDependency>(input, field, {
  kind: oneOf(dependencyKinds), id: token, version: apiVersion, required: optional(boolean),
});
const parseProvider: Parser<ManifestProvider> = (input, field) => object<ManifestProvider>(input, field, {
  kind: oneOf(providerKinds), id: token, apiVersion, cardinality: oneOf(providerCardinalities),
});
const parseContribution: Parser<ManifestContribution> = (input, field) => object<ManifestContribution>(input, field, {
  id: token, version: apiVersion, surface: oneOf(contributionSurfaces), runtime: oneOf(runtimeLocations),
  entry: optional(relativePath), requires: optional(array(parseDependency, 64)),
  provides: optional(array(parseProvider, 64)), capabilities: optional(array(token, 64)),
});
const parseOption: Parser<{readonly value: string; readonly label: string}> = (input, field) =>
  object<{readonly value: string; readonly label: string}>(input, field, {value: displayText, label: displayText});
const parseConfigurationField: Parser<ManifestConfigurationField> = (input, field) => object<ManifestConfigurationField>(input, field, {
  id: (value, path) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(value) ? value : invalid(path),
  label: displayText, type: configurationType, required: optional(boolean),
  options: optional(array(parseOption, 64)), description: optional(displayText),
});
const pageId: Parser<string> = (input, field) =>
  typeof input === 'string' && /^[a-z][a-zA-Z0-9-]{0,63}$/.test(input) ? input : invalid(field);
const catalogHref: Parser<string> = (input, field) =>
  typeof input === 'string' && input.startsWith('#/') && input.length <= 512 && !/[\r\n\0]/.test(input) ? input : invalid(field);
const sourceKindToken: Parser<string> = (input, field) =>
  typeof input === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(input) ? input : invalid(field);
const parseSourceCatalogEntry: Parser<ManifestSourceCatalogEntry> = (input, field) => object<ManifestSourceCatalogEntry>(input, field, {
  id: token, title: displayText, body: displayText, note: displayText, icon: token,
  kinds: array(sourceKindToken, 20),
  target: (value, path) => object<{readonly pageId: string; readonly href: string}>(value, path, {pageId, href: catalogHref}),
  setupChoiceId: optional(token), attachToBinding: optional(token),
});
function parseJsonValue(input: unknown, field: string): ManifestJsonValue {
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (Array.isArray(input)) return array<ManifestJsonValue>(parseJsonValue, 1024)(input, field);
  return parseJsonObject(input, field);
}
function parseJsonObject(input: unknown, field: string): ManifestJsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid(field);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid(field);
  const properties = Object.getOwnPropertyDescriptors(input);
  const result: Record<string, ManifestJsonValue> = {};
  for (const key of Reflect.ownKeys(properties)) {
    const descriptor = properties[key as keyof typeof properties];
    if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) return invalid(field);
    result[key] = parseJsonValue(descriptor.value, `${field}.${key}`);
  }
  return result;
}

const parseManifest: Parser<PackageManifest> = (input, field) => {
  const manifest = object<PackageManifest>(input, field, {
    schemaVersion: version,
    id: manifestId,
    name: displayText,
    version: token,
    trust: optional(oneOf(trustLevels)),
    runtime: oneOf(['worker', 'service']),
    entry: relativePath,
    archive: (value, path) => object<{readonly asset: string; readonly sha256: string}>(value, path, {asset: archiveAsset, sha256}),
    contributions: optional(array(parseContribution, 256)),
    capabilities: array(token, 64),
    actionCapabilities: optional(array(parseJsonObject, 8)),
    configuration: array(parseConfigurationField, 128),
    dependencies: array(parseDependency, 64),
    access: array(displayText, 64),
    sourceCatalog: optional(array(parseSourceCatalogEntry, 32)),
  });
  const contributionIds = new Set<string>();
  for (const contribution of manifest.contributions ?? []) {
    if (contributionIds.has(contribution.id)) return invalid(`${field}.contributions`);
    contributionIds.add(contribution.id);
    if (contribution.entry !== undefined) relativePath(contribution.entry, `${field}.contributions`);
  }
  const catalogIds = new Set<string>();
  for (const entry of manifest.sourceCatalog ?? []) {
    if (catalogIds.has(entry.id)) return invalid(`${field}.sourceCatalog`);
    catalogIds.add(entry.id);
  }
  return manifest;
};

export const packageManifestSchema = schema(parseManifest);

/** Browser/native-safe projection. The package Manifest remains the only
 * authored package authority. */
export interface FeatureManifestProjection {
  readonly id: string;
  readonly version: string;
  readonly components: readonly {
    readonly id: string;
    readonly version: string;
    readonly surface: ContributionSurface;
    readonly requires?: readonly {readonly id: string; readonly version: string}[];
  }[];
}
export function featureManifestForPackage(manifest: PackageManifest): FeatureManifestProjection {
  return {
    id: manifest.id,
    version: manifest.version,
    components: (manifest.contributions ?? []).map(contribution => {
      // FeatureRegistry can only resolve sibling contribution registrations.
      // Service/package/host dependencies are satisfied by the activation plan,
      // and optional dependencies must not become hard registry requirements.
      const requires = (contribution.requires ?? [])
        .filter(dependency => dependency.kind === 'contribution' && dependency.required !== false)
        .map(dependency => ({id: dependency.id, version: dependency.version}));
      return {
        id: contribution.id,
        version: contribution.version,
        surface: contribution.surface,
        ...(requires.length ? {requires} : {}),
      };
    }),
  };
}
