import type { CollectionEntry, HomeEntry, PageEntry, ViewEntry } from '../features/types';

/** One built-in Web plugin package: its package identity and the entries it
 * contributes. Later plugins can replace a shard with a real factory without
 * changing the registry consumers. */
export interface BuiltinWebPlugin {
  readonly id: string;
  readonly pages?: readonly PageEntry[];
  readonly collections?: readonly CollectionEntry[];
  readonly home?: readonly HomeEntry[];
  readonly panels?: readonly ViewEntry[];
  readonly renderers?: readonly ViewEntry[];
}
