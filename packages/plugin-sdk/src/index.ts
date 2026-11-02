/** Browser-safe public plugin author surface. Node-only host helpers are
 * exposed by the node condition/subpath, never by this entry. */
export * from '@mote/plugin-api';
export const PLUGIN_SDK_VERSION = '0.1.0' as const;
