import {parseAvailability, type Availability} from './capabilities.js';
import {parseContributionIdentity, parseHostIdentity, type ContributionIdentity, type HostIdentity} from './identity.js';
import {apiVersion, array, boolean, integer, invalid, object, schema, version, type Parser} from './schema.js';

export const PLUGIN_CONTRACT_VERSION = 1 as const;
export const MAX_SNAPSHOT_CONTRIBUTIONS = 4096;
export interface ContributionSnapshot {
  readonly identity: ContributionIdentity;
  readonly apiVersion: string;
  readonly availability: Availability;
  /** May be true while an old pinned implementation is active. A missing native build is separate.
   * Control-plane aggregation/allowed commands are not determined by this flag alone. */
  readonly restartRequired: boolean;
}
/** A host's runtime projection, not a package manifest, install/configuration/observed record or authorization.
 * Package composition has its own inputs/revision; this revision orders snapshots only within this host ID. */
export interface PluginSnapshot {
  readonly schemaVersion: typeof PLUGIN_CONTRACT_VERSION;
  readonly host: HostIdentity;
  readonly revision: number;
  readonly contributions: readonly ContributionSnapshot[];
}
const parseContributionSnapshot: Parser<ContributionSnapshot> = (input, field) => object(input, field, {
  identity: parseContributionIdentity, apiVersion, availability: parseAvailability, restartRequired: boolean,
});
export const contributionSnapshotSchema = schema(parseContributionSnapshot);
export const pluginSnapshotSchema = schema<PluginSnapshot>((input, field) => {
  const result = object<PluginSnapshot>(input, field, {schemaVersion: version, host: parseHostIdentity, revision: integer, contributions: array(parseContributionSnapshot, MAX_SNAPSHOT_CONTRIBUTIONS)});
  const identities = new Set<string>();
  for (const contribution of result.contributions) {
    const host = contribution.identity.scope.host;
    if (host.id !== result.host.id || host.kind !== result.host.kind) return invalid(`${field}.contributions`);
    const key = JSON.stringify(contribution.identity);
    if (identities.has(key)) return invalid(`${field}.contributions`);
    identities.add(key);
  }
  return result;
});
