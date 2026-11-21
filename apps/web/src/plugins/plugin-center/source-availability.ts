import type {PluginCenterView} from '@mote/shared';

/** Source kinds whose declaring package has no enabled instance. A stopped
 * plugin only stops its own connector: stored evidence stays readable in the
 * Library, while the connections directory no longer offers its sources. */
export function stoppedSourceKinds(view:PluginCenterView|undefined):ReadonlySet<string>{
  const declared=new Set<string>(),active=new Set<string>();
  for(const contribution of view?.sourceContributions??[]){
    const enabled=view?.instances.some(instance=>instance.id===contribution.instanceId&&instance.desired)??false;
    for(const kind of contribution.kinds){
      declared.add(kind);
      if(enabled)active.add(kind);
    }
  }
  return new Set([...declared].filter(kind=>!active.has(kind)));
}
