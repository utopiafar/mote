import {
  hostKinds,
  type ContributionSurface, type HostKind, type ManifestContribution, type ManifestDependency,
  type ManifestProvider, type PackageManifest, type RuntimeLocation, type TrustLevel,
} from '@mote/plugin-api';

/** Activation planning is pure. It never imports a package, opens storage,
 * starts a worker, calls a model or scans captured history. */
export const ACTIVATION_PLAN_VERSION = 1 as const;

export const activationFailureCodes = [
  'invalid_input', 'duplicate_package', 'duplicate_contribution', 'missing_dependency',
  'version_mismatch', 'api_incompatible', 'dependency_cycle', 'ambiguous_provider',
  'invalid_binding', 'unsupported_host', 'unsupported_runtime',
] as const;
export type ActivationFailureCode = typeof activationFailureCodes[number];

export interface ActivationFailure {
  readonly code: ActivationFailureCode;
  readonly message: string;
  readonly packageId?: string;
  readonly contributionId?: string;
  readonly dependency?: {readonly kind: ManifestDependency['kind']; readonly id: string; readonly version: string};
  readonly path?: readonly string[];
}

export interface PackageContributionAddress {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly contributionId: string;
}

export interface ServiceSelection {
  readonly service: {readonly id: string; readonly apiVersion: string};
  readonly provider: PackageContributionAddress;
}

export interface CompositionInput {
  readonly revision: number;
  readonly host: HostKind;
  readonly packages: readonly PackageManifest[];
  readonly bindings?: readonly ServiceSelection[];
}

export interface PlannedPackage {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly trust: TrustLevel;
  readonly runtime: PackageManifest['runtime'];
  readonly contributionIds: readonly string[];
}

export interface PlannedContribution {
  readonly address: PackageContributionAddress;
  readonly surface: ContributionSurface;
  readonly runtime: RuntimeLocation;
  readonly capabilities: readonly string[];
  readonly provides: readonly ManifestProvider[];
  readonly entry?: string;
}

export interface PlannedBinding {
  readonly service: {readonly id: string; readonly apiVersion: string};
  readonly provider: PackageContributionAddress;
}

export interface ActivationPlan {
  readonly schemaVersion: typeof ACTIVATION_PLAN_VERSION;
  readonly revision: number;
  readonly host: HostKind;
  readonly packages: readonly PlannedPackage[];
  readonly contributions: readonly PlannedContribution[];
  readonly bindings: readonly PlannedBinding[];
}

export type CompositionResult =
  | {readonly ok: true; readonly plan: ActivationPlan}
  | {readonly ok: false; readonly failures: readonly ActivationFailure[]};

interface NormalizedContribution {
  readonly manifest: PackageManifest;
  readonly address: PackageContributionAddress;
  readonly contribution: ManifestContribution;
}

const addressKey = (address: PackageContributionAddress) =>
  `${address.packageId}\u0000${address.packageVersion}\u0000${address.contributionId}`;
const contributionKey = (contribution: ManifestContribution) => `${contribution.id}\u0000${contribution.version}`;
const serviceKey = (service: {readonly id: string; readonly apiVersion: string}) =>
  `${service.id}\u0000${service.apiVersion}`;
const failure = (code: ActivationFailureCode, message: string, extra: Omit<ActivationFailure, 'code' | 'message'> = {}): ActivationFailure =>
  ({code, message, ...extra});

function runtimeSupported(host: HostKind, runtime: RuntimeLocation) {
  if (runtime === 'worker' || runtime === 'service') return host === 'central';
  if (runtime === 'host') return true;
  return host === 'mac' || host === 'android';
}

function dependencyFailure(
  dependency: ManifestDependency,
  code: 'missing_dependency' | 'version_mismatch' | 'api_incompatible',
  owner: {readonly packageId: string; readonly contributionId?: string},
) {
  return failure(code, code === 'missing_dependency' ? 'A required dependency is unavailable'
    : code === 'version_mismatch' ? 'A dependency version is not the exact declared version'
      : 'A dependency API version is incompatible', {
    packageId: owner.packageId,
    ...(owner.contributionId === undefined ? {} : {contributionId: owner.contributionId}),
    dependency: {kind: dependency.kind, id: dependency.id, version: dependency.version},
  });
}

export function planComposition(input: CompositionInput): CompositionResult {
  const failures: ActivationFailure[] = [];
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !hostKinds.includes(input.host)) {
    return {ok: false, failures: [failure('invalid_input', 'Composition input requires a nonnegative revision and a supported host')]};
  }

  const packages = new Map<string, PackageManifest>();
  for (const manifest of input.packages) {
    if (packages.has(manifest.id)) {
      failures.push(failure('duplicate_package', 'The same package identity appears more than once', {packageId: manifest.id}));
      continue;
    }
    packages.set(manifest.id, manifest);
  }

  const contributions = new Map<string, NormalizedContribution>();
  const byContributionId = new Map<string, NormalizedContribution[]>();
  for (const manifest of packages.values()) {
    // The package entry only runs on the host that starts it. Client hosts may
    // still activate this package's host/native contributions, which are
    // checked independently below.
    for (const contribution of manifest.contributions ?? []) {
      const address: PackageContributionAddress = {
        packageId: manifest.id, packageVersion: manifest.version, contributionId: contribution.id,
      };
      const normalized = {manifest, address, contribution};
      if (contributions.has(addressKey(address))) {
        failures.push(failure('duplicate_contribution', 'The same contribution address appears more than once', {
          packageId: manifest.id, contributionId: contribution.id,
        }));
        continue;
      }
      contributions.set(addressKey(address), normalized);
      const existing = byContributionId.get(contribution.id) ?? [];
      existing.push(normalized);
      byContributionId.set(contribution.id, existing);
      if (!runtimeSupported(input.host, contribution.runtime)) {
        failures.push(failure('unsupported_runtime', 'The contribution execution location is unavailable on this host', {
          packageId: manifest.id, contributionId: contribution.id,
        }));
      }
    }
  }
  for (const [id, entries] of byContributionId) {
    if (entries.length > 1) failures.push(failure('duplicate_contribution', 'A contribution ID must identify one current implementation', {contributionId: id}));
  }

  const providers = new Map<string, NormalizedContribution[]>();
  for (const normalized of contributions.values()) {
    for (const provider of normalized.contribution.provides ?? []) {
      const key = `${provider.kind}\u0000${provider.id}\u0000${provider.apiVersion}`;
      const entries = providers.get(key) ?? [];
      entries.push(normalized);
      providers.set(key, entries);
    }
  }

  const resolveDependency = (dependency: ManifestDependency, owner: {packageId: string; contributionId?: string}) => {
    if (dependency.required === false) return;
    // Host-distribution prerequisites are shipped with this host build, not
    // installed as another plugin package.
    if (dependency.kind === 'host') return;
    if (dependency.kind === 'package') {
      const target = packages.get(dependency.id);
      if (!target) failures.push(dependencyFailure(dependency, 'missing_dependency', owner));
      else if (target.version !== dependency.version) failures.push(dependencyFailure(dependency, 'version_mismatch', owner));
      return;
    }
    if (dependency.kind === 'contribution') {
      const candidates = byContributionId.get(dependency.id) ?? [];
      if (!candidates.length) failures.push(dependencyFailure(dependency, 'missing_dependency', owner));
      else if (!candidates.some(candidate => candidate.contribution.version === dependency.version)) failures.push(dependencyFailure(dependency, 'version_mismatch', owner));
      return;
    }
    const compatible = providers.get(`service\u0000${dependency.id}\u0000${dependency.version}`) ?? [];
    if (compatible.length) return;
    const sameService = [...providers.entries()].some(([key]) => key.startsWith(`service\u0000${dependency.id}\u0000`));
    failures.push(dependencyFailure(dependency, sameService ? 'api_incompatible' : 'missing_dependency', owner));
  };

  for (const manifest of packages.values()) {
    for (const dependency of manifest.dependencies) resolveDependency(dependency, {packageId: manifest.id});
    for (const contribution of manifest.contributions ?? []) {
      for (const dependency of contribution.requires ?? []) {
        resolveDependency(dependency, {packageId: manifest.id, contributionId: contribution.id});
      }
    }
  }

  // Package and contribution dependencies are activation edges; a service
  // dependency is a runtime lease and is not a second activation edge.
  const graph = new Map<string, string[]>();
  const addEdge = (from: string, to: string) => {
    const edges = graph.get(from) ?? [];
    edges.push(to);
    graph.set(from, edges);
  };
  for (const manifest of packages.values()) {
    const from = `package:${manifest.id}`;
    for (const dependency of manifest.dependencies) {
      if (dependency.required === false) continue;
      if (dependency.kind === 'package' && packages.has(dependency.id)) addEdge(from, `package:${dependency.id}`);
      if (dependency.kind === 'contribution') {
        for (const candidate of byContributionId.get(dependency.id) ?? []) addEdge(from, `contribution:${addressKey(candidate.address)}`);
      }
    }
    for (const contribution of manifest.contributions ?? []) {
      const contributionNode = `contribution:${addressKey({packageId: manifest.id, packageVersion: manifest.version, contributionId: contribution.id})}`;
      // A contribution cannot activate before its owning package.
      addEdge(contributionNode, `package:${manifest.id}`);
      for (const dependency of contribution.requires ?? []) {
        if (dependency.required === false) continue;
        if (dependency.kind === 'package' && packages.has(dependency.id)) addEdge(contributionNode, `package:${dependency.id}`);
        if (dependency.kind === 'contribution') {
          for (const candidate of byContributionId.get(dependency.id) ?? []) {
            if (candidate.contribution.version === dependency.version) addEdge(contributionNode, `contribution:${addressKey(candidate.address)}`);
          }
        }
      }
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (node: string, path: string[]) => {
    if (visiting.has(node)) {
      const cycle = [...path.slice(path.indexOf(node)), node];
      failures.push(failure('dependency_cycle', 'Activation dependencies contain a cycle', {path: cycle}));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node, []);

  const selections = new Map<string, PackageContributionAddress>();
  for (const selection of input.bindings ?? []) {
    const key = serviceKey(selection.service);
    if (selections.has(key)) {
      failures.push(failure('invalid_binding', 'A service has more than one explicit provider selection'));
      continue;
    }
    selections.set(key, selection.provider);
  }

  const bindings: PlannedBinding[] = [];
  for (const [providerKey, entries] of providers) {
    const [kind, id, apiVersion] = providerKey.split('\u0000') as [ManifestProvider['kind'], string, string];
    if (kind !== 'service') continue;
    const unique = [...new Map(entries.map(entry => [addressKey(entry.address), entry])).values()];
    const service = {id, apiVersion};
    const selected = selections.get(serviceKey(service));
    if (selected) {
      const match = unique.find(entry => addressKey(entry.address) === addressKey(selected));
      if (!match) failures.push(failure('invalid_binding', 'The selected provider does not provide the exact service API'));
      else bindings.push({service, provider: selected});
      continue;
    }
    if (unique.length === 1) bindings.push({service, provider: unique[0]!.address});
    else if (unique.some(entry => (entry.contribution.provides ?? []).some(provider => provider.kind === 'service' && provider.id === id && provider.apiVersion === apiVersion && provider.cardinality === 'single'))) {
      failures.push(failure('ambiguous_provider', 'A single-valued service has more than one provider and no explicit selection'));
    }
  }
  for (const [key, selected] of selections) {
    if (!providers.has(`service\u0000${key}`)) failures.push(failure('invalid_binding', 'A selected service has no provider'));
    else if (!bindings.some(binding => serviceKey(binding.service) === key && addressKey(binding.provider) === addressKey(selected))) {
      // A selection for an unambiguous service is still a valid explicit pin.
      bindings.push({service: {id: key.split('\u0000')[0]!, apiVersion: key.split('\u0000')[1]!}, provider: selected});
    }
  }

  if (failures.length) return {ok: false, failures};

  const plannedPackages: PlannedPackage[] = [...packages.values()].map(manifest => ({
    packageId: manifest.id, packageVersion: manifest.version,
    trust: manifest.trust ?? 'external', runtime: manifest.runtime,
    contributionIds: (manifest.contributions ?? []).map(contribution => contribution.id),
  }));
  const plannedContributions: PlannedContribution[] = [...contributions.values()].map(({address, contribution}) => ({
    address, surface: contribution.surface, runtime: contribution.runtime,
    capabilities: contribution.capabilities ?? [], provides: contribution.provides ?? [],
    ...(contribution.entry === undefined ? {} : {entry: contribution.entry}),
  }));
  return {
    ok: true,
    plan: {schemaVersion: ACTIVATION_PLAN_VERSION, revision: input.revision, host: input.host, packages: plannedPackages, contributions: plannedContributions, bindings},
  };
}
