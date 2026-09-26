/** Browser-safe feature contracts. Descriptors contain no credentials, paths or executable code. */
export type FeatureSurface = 'ingress'|'upload'|'data'|'command'|'agent'|'processing'|'page'|'collection'|'renderer'|'panel'|'settings';
export type FeatureComponent = {id:string;version:string;surface:FeatureSurface;requires?:string[]};
export type FeatureManifest = {id:string;version:string;components:FeatureComponent[]};
export type FeatureCapability = FeatureComponent & {featureId:string;state:'active'|'unavailable';reason?:string};
export type FeatureInventory = {schemaVersion:1;revision:number;features:FeatureManifest[];capabilities:FeatureCapability[]};

/** The same scoped registry is consumed by both hosts; values never cross the network. */
export class FeatureRegistry<T> {
  private entries=new Map<string,{featureId:string;descriptor:FeatureComponent;value:T}>();
  private manifests=new Map<string,FeatureManifest>();
  private listeners=new Set<()=>void>();
  private revision=0;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  getRevision=()=>this.revision;
  private changed(){this.revision++;for(const listener of this.listeners)listener();}
  install(manifest:FeatureManifest){
    if(this.manifests.has(manifest.id))throw Error('Feature already installed: '+manifest.id);
    if(!manifest.id||!manifest.version||new Set(manifest.components.map(c=>c.id)).size!==manifest.components.length)throw Error('Invalid feature manifest');
    for(const component of manifest.components)if(!component.id||!component.version)throw Error('Invalid feature component');
    const pinned=structuredClone(manifest);this.manifests.set(manifest.id,pinned);this.changed();
    return ()=>{if(this.manifests.get(manifest.id)!==pinned)return;for(const [id,entry] of this.entries)if(entry.featureId===manifest.id)this.entries.delete(id);this.manifests.delete(manifest.id);this.changed();};
  }
  register(featureId:string,descriptor:FeatureComponent,value:T){
    const feature=this.manifests.get(featureId);
    if(!feature)throw Error('Feature is not installed: '+featureId);
    const declared=feature.components.find(c=>c.id===descriptor.id);
    if(declared&&(declared.surface!==descriptor.surface||declared.version!==descriptor.version))throw Error('Component contract mismatch: '+descriptor.id);
    if(this.entries.has(descriptor.id))throw Error('Component already registered: '+descriptor.id);
    const entry={featureId,descriptor:structuredClone(descriptor),value};this.entries.set(descriptor.id,entry);this.changed();
    return ()=>{if(this.entries.get(descriptor.id)!==entry)return;this.entries.delete(descriptor.id);this.changed();};
  }
  private available(id:string,visited=new Set<string>()):boolean {
    const entry=this.entries.get(id);if(!entry||visited.has(id))return false;
    const path=new Set(visited).add(id);return (entry.descriptor.requires??[]).every(dep=>this.available(dep,path));
  }
  get(id:string){return this.available(id)?this.entries.get(id)?.value:undefined;}
  list(surface?:FeatureSurface){return [...this.entries.values()].filter(e=>(!surface||e.descriptor.surface===surface)&&this.available(e.descriptor.id)).map(e=>({...e,descriptor:structuredClone(e.descriptor)}));}
  inventory():FeatureInventory{
    const features=[...this.manifests.values()].map(m=>structuredClone(m));
    const capabilities:FeatureCapability[]=[...this.entries.values()].map(e=>({...structuredClone(e.descriptor),featureId:e.featureId,state:this.available(e.descriptor.id)?'active':'unavailable',...(!this.available(e.descriptor.id)?{reason:'dependency_unavailable'}:{})}));
    for(const feature of features)for(const descriptor of feature.components)if(!capabilities.some(c=>c.id===descriptor.id&&c.featureId===feature.id))capabilities.push({...descriptor,featureId:feature.id,state:'unavailable',reason:'component_not_registered'});
    return {schemaVersion:1,revision:this.revision,features,capabilities};
  }
}
