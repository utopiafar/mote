import { moteText } from '@mote/shared/i18n';
import { bootstrapPlugins, builtinInstance, teardownPlugins } from '../plugin-host/bootstrap';
import type { PluginContributionScope } from '../plugin-host/contributions';
import type { WebContribution } from './host';
import { builtinCollections } from './collections';
import { builtinPages } from './entries';
import { homeEntries } from './agent-view';
import { webFeatures } from './registry';
import { MemoryRecordPanel } from './memory-record';
import { sourceMaterialViews } from './source-material';
import { ownerQuestionPanels } from './owner-questions';

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
  const instances=[
    ...[...new Set([...builtinPages,...builtinCollections,...homeEntries].map(page=>page.featureId))].map(id=>builtinInstance(id,[
      ...builtinPages.filter(page=>page.featureId===id).map(entry=>({surface:'page' as const,entry})),
      ...builtinCollections.filter(page=>page.featureId===id).map(entry=>({surface:'collection' as const,entry})),
      ...homeEntries.filter(entry=>entry.featureId===id).map(entry=>({surface:'home' as const,entry})),
    ])),
    builtinInstance('mote.saved-record-views',[
      {surface:'panel',entry:{id:'memory.saved',kind:'mote.memory',schemaVersion:1,representation:'saved-record',render:({value})=><MemoryRecordPanel record={JSON.parse(value.text)}/>}},
      {surface:'panel',entry:{id:'operation.saved',kind:'mote.operation',schemaVersion:1,representation:'saved-record',render:({value})=><details><summary>{moteText('保存记录（只读）')}</summary><pre className="feature-json">{value.text}</pre></details>}},
    ]),
    builtinInstance('mote.source-material-views',sourceMaterialViews.map(entry=>({surface:'renderer' as const,entry}))),
    builtinInstance('mote.owner-questions',ownerQuestionPanels.map(entry=>({surface:'panel' as const,entry}))),
  ] as InstanceSnapshotInput[];
  const result=await bootstrapPlugins(webFeatures,instances);
  for(const [instanceId,scope] of result.scopes)featureScopes.set(instanceId,scope);
  const {reports}=result;
  const failed=reports.find(report=>report.outcome.observed==='failed');
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
