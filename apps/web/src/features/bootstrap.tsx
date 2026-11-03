import { bootstrapPlugins, builtinInstance, teardownPlugins } from '../plugin-host/bootstrap';
import type { PluginContributionScope } from '../plugin-host/contributions';
import { builtinPlugins, pluginContributions } from '../plugins';
import { webFeatures } from './registry';

// Only the application entrypoint installs builtins. View and registry consumers
// can be imported without starting feature installation.
/** The scopes created by the real application bootstrap stay owned here so
 * application teardown can release them; tests and the entrypoint share one
 * path. */
export const featureScopes=new Map<string,PluginContributionScope>();

// Builtin packages declare their own instance snapshots and pass through the
// same scope-owned bootstrap as external plugins; desired+compatible gates are
// identical, and observed mounts come back from the actual install result.
export const featuresReady=(async()=>{
  const instances=builtinPlugins.map(plugin=>builtinInstance(plugin.id,pluginContributions(plugin))) as InstanceSnapshotInput[];
  const result=await bootstrapPlugins(webFeatures,instances);
  for(const [instanceId,scope] of result.scopes)featureScopes.set(instanceId,scope);
  const {reports}=result;
  // The plugin center is itself replaceable. A failed mount must not prevent
  // the shell from starting; the host-owned rescue route stays reachable.
  const failed=reports.find(report=>report.outcome.observed==='failed'&&report.packageId!=='mote.features');
  if(failed&&failed.outcome.observed==='failed'){
    const original=failed.outcome.error;
    throw Object.assign(new Error(`Plugin ${original.pluginId} failed to mount`,{cause:original.cause}),{pluginId:original.pluginId,instanceId:original.instanceId});
  }
})();
type InstanceSnapshotInput=import('../plugin-host/contributions').InstanceSnapshot;

export const featuresTeardown=async()=>{
  const result=await teardownPlugins(featureScopes);
  featureScopes.clear();
  await webFeatures.close();
  return result;
};
