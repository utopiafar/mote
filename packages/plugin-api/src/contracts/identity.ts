import {object, oneOf, schema, token, type Parser} from './schema.js';

export const hostKinds = ['central', 'web', 'mac', 'android'] as const;
export type HostKind = typeof hostKinds[number];
/** A host runtime incarnation. Fresh on host recreation; not deviceId, owner identity or a browser profile. */
export interface HostIdentity { readonly kind: HostKind; readonly id: string }
/** IDs are host-issued opaque values. Reinstall changes installationId; instances never share state identity. */
export interface InstanceIdentity {
  /** Stable canonical Manifest ID; artifact version/digest/address belong to H03's package descriptor. */
  readonly packageId: string;
  /** Installed deployment identity, including host-registered bundled builds. Never an activation ID. */
  readonly installationId: string;
  readonly instanceId: string;
}
/** Each activation gets a new ID. This execution scope is not a domain data namespace (e.g. 'default').
 * Parsing an identity does not authenticate it; hosts bind their own identity and authority. */
export interface ScopeIdentity extends InstanceIdentity {
  readonly host: HostIdentity;
  readonly activationId: string;
}
/** Opaque canonical contribution ID, never parsed as a surface:id prefix. Kind/entry live in H03. */
export interface ContributionIdentity { readonly scope: ScopeIdentity; readonly contributionId: string }

export const parseHostIdentity: Parser<HostIdentity> = (input, field) => object(input, field, {kind: oneOf(hostKinds), id: token});
export const parseInstanceIdentity: Parser<InstanceIdentity> = (input, field) => object(input, field, {packageId: token, installationId: token, instanceId: token});
export const parseScopeIdentity: Parser<ScopeIdentity> = (input, field) => object(input, field, {packageId: token, installationId: token, instanceId: token, host: parseHostIdentity, activationId: token});
export const parseContributionIdentity: Parser<ContributionIdentity> = (input, field) => object(input, field, {scope: parseScopeIdentity, contributionId: token});
export const hostIdentitySchema = schema(parseHostIdentity);
export const instanceIdentitySchema = schema(parseInstanceIdentity);
export const scopeIdentitySchema = schema(parseScopeIdentity);
export const contributionIdentitySchema = schema(parseContributionIdentity);
