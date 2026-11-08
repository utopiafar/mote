import {join} from 'node:path';
import type {PluginInstanceView} from '@mote/shared';
import type {PluginCenter,StoredPackage} from './plugin-center.js';
import {memoryProviderNamespaceSchema,type MemoryProvider,type MemoryProviderNamespace} from './memory-provider-contract.js';
import {WorkerMemoryProvider} from './worker-memory-provider.js';
import {sha256,StoreError} from './store.js';
import {probeMemoryProvider} from './memory-provider-probe.js';
import type {MemoryEngine} from './memory-native-stage-contract.js';
import type {ModelSettingsStore} from './model-settings.js';

type ProviderConfiguration={namespace:MemoryProviderNamespace;package:StoredPackage;instance:PluginInstanceView;identity:string};

/** Third-party Memory providers use the worker ABI. An installed engine adapter
 * may offer the same semantic transport seam; the host never constructs one. */
export class MemoryAdapters {
  private providers=new Map<string,MemoryProvider>();
  private closed=false;
  private closing?:Promise<void>;
  constructor(private directory:string,private plugins:PluginCenter,private models:ModelSettingsStore){plugins.store.db.exec('CREATE TABLE IF NOT EXISTS memory_provider_configurations(id TEXT PRIMARY KEY,json TEXT NOT NULL);');plugins.store.registerStorage('memory-provider-adapters',{memory_provider_configurations:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128'});}
  configurationAllowed(type:string,value:string|number|boolean){if(typeof value!=='string')return false;try{if(type==='model-profile'){this.models.select('memory',value);return true;}if(type==='secret-reference'&&value.startsWith('model:'))return Boolean(this.models.select('memory',value.slice(6)).settings.apiKey);}catch{}return false;}
  private configuration(id:string,namespace?:MemoryProviderNamespace){
    if(!namespace)return {instance:this.plugins.instanceView(id),package:this.plugins.packageForInstance(id),identity:this.plugins.configurationIdentity(id)};
    const ns=memoryProviderNamespaceSchema.parse(namespace);if(ns.instanceId!==id)throw new StoreError('Memory namespace belongs to a different plugin instance',409);
    const tag=sha256(JSON.stringify(ns)),prior=this.plugins.store.db.prepare('SELECT json FROM memory_provider_configurations WHERE id=?').get(tag);
    if(prior){const value=JSON.parse(String(prior.json)) as ProviderConfiguration;if(JSON.stringify(memoryProviderNamespaceSchema.parse(value.namespace))!==JSON.stringify(ns)||value.instance.id!==id||value.instance.packageId!==value.package.view.id||!value.identity)throw new StoreError('The retained Memory configuration requires recovery',503);return {...value,package:{...value.package,directory:join(this.plugins.releases.directory,value.package.view.source.digest)}};}
    const currentBinding=this.plugins.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_plan_binding'").get()?this.plugins.store.db.prepare('SELECT json FROM memory_plan_binding WHERE id=1').get():undefined,currentNamespace=currentBinding?JSON.parse(String(currentBinding.json)).namespace:undefined;
    if(JSON.stringify(currentNamespace)!==JSON.stringify(ns)&&['memory_provider_receipts','memory_provider_writes'].some(table=>this.plugins.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)&&this.plugins.store.db.prepare('SELECT json FROM '+table).all().some(row=>JSON.stringify(JSON.parse(String(row.json)).namespace)===JSON.stringify(ns))))throw new StoreError('The historical Memory namespace has no verified configuration mapping; recover it before erasing or reading its data',503);
    const value:ProviderConfiguration={namespace:ns,instance:this.plugins.instanceView(id),package:this.plugins.packageForInstance(id),identity:this.plugins.configurationIdentity(id)},json=JSON.stringify(value);
    this.plugins.store.reserveMetadata(Buffer.byteLength(json));this.plugins.store.db.prepare('INSERT INTO memory_provider_configurations VALUES(?,?)').run(tag,json);return value;
  }
  configurationIdentity(id:string,namespace?:MemoryProviderNamespace){return this.configuration(id,namespace).identity;}
  provider(id:string,namespace?:MemoryProviderNamespace){if(this.closed)throw new StoreError('Memory adapters are closing',503);const configuration=this.configuration(id,namespace),instance=configuration.instance,pkg=configuration.package,identity=configuration.identity,key=id+':'+identity,existing=this.providers.get(key);if(existing)return existing;
    if(!pkg.directory||pkg.view.state!=='installed')throw new StoreError('The plugin artifact is unavailable',409);
    this.plugins.releases.verifyInstalled(pkg.directory,pkg.view.source.digest,pkg.manifest);
    const provider=new WorkerMemoryProvider(this.plugins.runtimeFactory?.(pkg,instance)??this.plugins.runtimeFor(pkg,instance));
    this.providers.set(key,provider);return provider;
  }
  private async restart(id:string){const key=id+':'+this.plugins.configurationIdentity(id),prior=this.providers.get(key);this.providers.delete(key);await prior?.close();await this.plugins.resetRuntime(id);return this.provider(id);}
  async probe(id:string,signal:AbortSignal){const pkg=this.plugins.packageForInstance(id),provider=await this.restart(id),namespace={ownerId:'mote-owner',instanceId:id,bindingRevision:1};signal.throwIfAborted();
    const health=await probeMemoryProvider({provider,restart:()=>this.restart(id),namespace,providerId:pkg.manifest.id,version:pkg.manifest.version,signal});signal.throwIfAborted();
    return {capabilities:pkg.manifest.capabilities.map(capability=>{
      if(capability==='engine')return {id:capability,state:'unsupported' as const,reason:'The third-party worker ABI supports repository and retrieval; engine execution is not implemented'};
      const verified=health.ready&&(capability==='repository'?health.verified.persistentCrud&&health.verified.immutableRecords&&health.verified.idempotentReplay:capability==='retrieval'?health.verified.scopedRetrieval:health.verified.persistentCrud&&health.verified.scopedRetrieval&&health.verified.immutableRecords&&health.verified.idempotentReplay);
      return {id:capability,state:verified?'verified' as const:'unknown' as const,reason:verified?undefined:'The actual provider probe did not complete'};
    }),issues:health.problems};
  }
  engine(id:string,namespace?:MemoryProviderNamespace):MemoryEngine{const provider=this.provider(id,namespace);if(typeof (provider as Partial<MemoryEngine>).prepare!=='function')throw new StoreError('The bound provider is not an engine',409);return provider as unknown as MemoryEngine;}
  async discardPrepared(input:{namespace:MemoryProviderNamespace;configurationIdentity:string;opId:string;phase:'extract'|'integrate'}){const configuration=this.configuration(input.namespace.instanceId,input.namespace);if(configuration.identity!==input.configurationIdentity)throw new StoreError('Native cleanup configuration differs from its admitted operation',409);const provider=this.provider(input.namespace.instanceId,input.namespace) as Partial<MemoryEngine>;if(typeof provider.discardPrepared!=='function')throw new StoreError('The retained native Memory engine requires recovery',503);await provider.discardPrepared(input);}
  async erasePreparedEvidence(evidenceIds:readonly string[]){const configurations=this.plugins.store.db.prepare('SELECT json FROM memory_provider_configurations').all().map(row=>JSON.parse(String(row.json)) as ProviderConfiguration),seen=new Set<string>();for(const value of configurations){const key=value.instance.id+':'+value.identity;if(seen.has(key)||!value.package.manifest.capabilities.includes('engine'))continue;seen.add(key);const provider=this.provider(value.instance.id,value.namespace) as Partial<MemoryEngine>;if(typeof provider.erasePreparedEvidence==='function')await provider.erasePreparedEvidence(evidenceIds);}}
  async retire(id:string){const values=[...this.providers.entries()].filter(([key])=>key.startsWith(id+':'));for(const [key] of values)this.providers.delete(key);await Promise.allSettled(values.map(([,provider])=>provider.close()));}
  close(){if(this.closing)return this.closing;this.closed=true;return this.closing=(async()=>{await Promise.allSettled([...this.providers.values()].map(provider=>provider.close()));this.providers.clear();})();}
}
