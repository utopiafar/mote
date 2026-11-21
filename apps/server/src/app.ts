import type {ConfigurationPlatformOptions} from './config.js';
import {buildHost,type HostDependencies} from './host.js';

export type {QueryAgent} from './host.js';

/** Start the host and connect onboarding to its existing batch and card services. */
export async function buildApp(configuration:ConfigurationPlatformOptions,dependencies?:HostDependencies){
  const host=await buildHost(configuration,dependencies);
  host.featureServices.assistantOnboarding.bindOutputs(host.batchProcessing,host.featureServices.assistantCards);
  return host;
}
