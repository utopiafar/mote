/** Build-time native provider registry for the Mac host. Providers ship inside
 * the client build and are registered at startup; nothing arrives over the
 * network. Capability matching is exact (capability + apiVersion + platform),
 * per the frozen U01 descriptor contract. */
import {
  nativeProviderKey, nativeProviderSatisfies, parseNativeProvider,
  type NativeProviderDescriptor,
} from '@mote/shared/plugin-native';
import type {NativeRequirement, PluginPlatform} from '@mote/shared/plugin-ui';

export class NativeProviderRegistry {
  #providers = new Map<string, NativeProviderDescriptor>();
  readonly platform: PluginPlatform;

  constructor(platform: PluginPlatform = 'mac') {
    this.platform = platform;
  }

  /** Register one build-shipped provider. Descriptors are wire-parsed; a
   * provider for another platform or a duplicate identity is rejected. */
  register(input: unknown): NativeProviderDescriptor {
    const descriptor = parseNativeProvider(input);
    if (descriptor.platform !== this.platform)
      throw new TypeError(`Provider platform ${descriptor.platform} cannot serve host ${this.platform}`);
    const key = nativeProviderKey(descriptor);
    if (this.#providers.has(key)) throw new TypeError('Native provider already registered');
    this.#providers.set(key, descriptor);
    return descriptor;
  }

  /** True when a registered provider exactly satisfies the requirement. */
  satisfies(requirement: NativeRequirement): boolean {
    for (const provider of this.#providers.values())
      if (nativeProviderSatisfies(requirement, provider)) return true;
    return false;
  }

  provider(capability: string, apiVersion: string): NativeProviderDescriptor | undefined {
    return this.#providers.get(`${capability}@${apiVersion}`);
  }

  list(): readonly NativeProviderDescriptor[] { return [...this.#providers.values()]; }
}
