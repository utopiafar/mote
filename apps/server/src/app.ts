import type {ConfigurationPlatformOptions} from './config.js';
import {buildHost,type HostDependencies} from './host.js';

export type {QueryAgent} from './host.js';

/** The server entrypoint only starts the host. Domain construction, route
 * contributions and shutdown order live behind `host.ts` and the selected
 * plugin/factory modules, never in this file. */
export function buildApp(configuration:ConfigurationPlatformOptions,dependencies?:HostDependencies){
  return buildHost(configuration,dependencies);
}
