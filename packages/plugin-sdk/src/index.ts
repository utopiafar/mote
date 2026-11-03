/** Browser-safe public plugin author surface. Node-only host helpers are
 * exposed by the node condition/subpath, never by this entry. */
export * from '@mote/plugin-api';
/** Instance state is host-bound: authors consume the injected store and never
 * pass a package, installation or instance identity. */
export {StateError, stateLimits} from '@mote/plugin-api';
export type {StateCheckpoint, StateErrorCode, StateLimits, StateRecord, StateStore, StateValue} from '@mote/plugin-api';
export const PLUGIN_SDK_VERSION = '0.1.0' as const;
