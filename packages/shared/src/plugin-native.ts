/** Native provider descriptors are wire metadata for capabilities shipped in a
 * client build. A provider never arrives over the network; its descriptor only
 * reports what a build can satisfy. OS grants are runtime authorization facts
 * published separately, never folded into capability or availability data. */
import {pluginPlatforms, type NativeRequirement, type PluginPlatform} from './plugin-ui.js';

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

const isToken = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
const isApiVersion = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);
const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Strict wire parser for a build-registered provider descriptor. */
export function parseNativeProvider(input: unknown): NativeProviderDescriptor {
  if (!isPlain(input) || !Reflect.ownKeys(input).every(key => typeof key === 'string'
    && ['capability', 'apiVersion', 'platform', 'buildId', 'osGrants'].includes(key)))
    throw new TypeError('Invalid native provider descriptor');
  if (!isToken(input.capability) || !isApiVersion(input.apiVersion) || !isToken(input.buildId))
    throw new TypeError('Invalid native provider identity');
  if (!(pluginPlatforms as readonly string[]).includes(input.platform as string))
    throw new TypeError('Invalid native provider platform');
  if (input.osGrants !== undefined
    && (!Array.isArray(input.osGrants) || !input.osGrants.every(isToken)))
    throw new TypeError('Invalid native provider grants');
  return {
    capability: input.capability, apiVersion: input.apiVersion,
    platform: input.platform as PluginPlatform, buildId: input.buildId,
    ...(input.osGrants !== undefined ? {osGrants: [...(input.osGrants as string[])]} : {}),
  };
}
