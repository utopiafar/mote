/** Native provider descriptors are wire metadata for capabilities shipped in a
 * client build. A provider never arrives over the network; its descriptor only
 * reports what a build can satisfy. OS grants are runtime authorization facts
 * published separately, never folded into capability or availability data. */
import {isApiVersion, isToken, pluginPlatforms, strictDataArray, strictDataObject, type NativeRequirement, type PluginPlatform} from './plugin-ui.js';

export interface NativeProviderDescriptor {
  /** Capability identity satisfying NativeRequirement.capability. */
  readonly capability: string;
  readonly apiVersion: string;
  readonly platform: PluginPlatform;
  /** The client build that compiled this provider in; reinstall/rebuild issues
   * a new build identity. */
  readonly buildId: string;
  /** OS grants this provider may need, declared so hosts can show permission
   * state. A listed grant is a requirement hint, not proof of authorization. */
  readonly osGrants?: readonly string[];
}

/** Identity key shared by the TS loader and the Kotlin decoder. */
export function nativeCapabilityKey(requirement: Pick<NativeRequirement, 'capability' | 'apiVersion'>): string {
  return `${requirement.capability}@${requirement.apiVersion}`;
}

export function nativeProviderKey(provider: Pick<NativeProviderDescriptor, 'capability' | 'apiVersion'>): string {
  return nativeCapabilityKey(provider);
}

/** Exact capability/apiVersion/platform match. A provider for another platform
 * or version never satisfies the requirement silently. */
export function nativeProviderSatisfies(requirement: NativeRequirement, provider: NativeProviderDescriptor): boolean {
  return provider.capability === requirement.capability
    && provider.apiVersion === requirement.apiVersion
    && requirement.platforms.includes(provider.platform);
}

/** Strict wire parser for a build-registered provider descriptor. Accessors
 * and non-plain arrays are rejected before any field value is read. */
export function parseNativeProvider(input: unknown): NativeProviderDescriptor {
  const value = strictDataObject(input, ['capability', 'apiVersion', 'platform', 'buildId', 'osGrants']);
  if (!isToken(value.capability) || !isApiVersion(value.apiVersion) || !isToken(value.buildId))
    throw new TypeError('Invalid native provider identity');
  if (!(pluginPlatforms as readonly string[]).includes(value.platform as string))
    throw new TypeError('Invalid native provider platform');
  if (value.osGrants !== undefined) {
    const grants = strictDataArray(value.osGrants, 64);
    if (!grants.every(isToken)) throw new TypeError('Invalid native provider grants');
  }
  return {
    capability: value.capability, apiVersion: value.apiVersion,
    platform: value.platform as PluginPlatform, buildId: value.buildId,
    ...(value.osGrants !== undefined ? {osGrants: strictDataArray(value.osGrants, 64) as string[]} : {}),
  };
}
