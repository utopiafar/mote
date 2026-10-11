import {join} from 'node:path';
import {existsSync} from 'node:fs';
import type {PluginCenter,StoredPackage} from './plugin-center.js';
import {memoryProviderNamespaceSchema,type MemoryProvider,type MemoryProviderNamespace} from './memory-provider-contract.js';
import {WorkerPluginRuntime} from './plugin-runtime.js';
import {Mem0MemoryProvider} from './mem0-memory-provider.js';
import {WorkerMemoryProvider} from './worker-memory-provider.js';
import {sha256,StoreError} from './store.js';
import type {AgentOptions} from '@mote/agent';
import {probeMemoryProvider} from './memory-provider-probe.js';
import {createHindsightEngine,HindsightEngine} from './hindsight-engine.js';
import {hindsightModelFingerprint,type HindsightModelRequest} from './hindsight-runtime.js';
import type {TokenUsage,PluginInstanceView} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import {ModelSettingsError,type ModelSettingsStore} from './model-settings.js';

type ProviderConfiguration={namespace:MemoryProviderNamespace;package:StoredPackage;instance:PluginInstanceView;identity:string};
class EmbeddingCredentialUnavailableError extends StoreError{}

/** Executable compatibility recipes are part of the pinned Mote distribution.
 * Upstream archives provide exact source provenance and are never executed as
 * ad-hoc installation scripts. Arbitrary adapters use the worker ABI. */
export class MemoryAdapters {
  private providers=new Map<string,MemoryProvider>();
  private closed=false;
  private closing?:Promise<void>;
  constructor(private directory:string,private plugins:PluginCenter,private models:ModelSettingsStore,private options:{codex?:{executable?:string;home?:string};runModelFor?:(settings:ModelSettings)=>AgentOptions['runModel'];assertModelAuthority?:(settings:ModelSettings,request:HindsightModelRequest)=>void|Promise<void>;onUsage?:(settings:ModelSettings,usage:TokenUsage,request:{requestId:string;opId?:string})=>void;onRequestStarted?:(settings:ModelSettings,request:{requestId:string;opId?:string})=>void;onRequestFinished?:(request:{requestId:string;opId?:string;status:'completed'|'failed'})=>void}={}){plugins.store.db.exec('CREATE TABLE IF NOT EXISTS memory_provider_model_snapshots(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_provider_configurations(id TEXT PRIMARY KEY,json TEXT NOT NULL);');}
  configurationAllowed(type:string,value:string|number|boolean){if(typeof value!=='string')return false;try{if(type==='model-profile'){this.models.select('memory',value);return true;}if(type==='secret-reference'&&value.startsWith('model:'))return Boolean(this.models.select('memory',value.slice(6)).settings.apiKey);}catch{}return false;}
  private secret(reference:unknown){if(reference===undefined||reference==='')return undefined;if(typeof reference!=='string'||!reference.startsWith('model:'))throw new StoreError('Choose an existing model credential reference');const key=this.models.select('memory',reference.slice(6)).settings.apiKey;if(!key)throw new EmbeddingCredentialUnavailableError('The credential reference is empty');return key;}
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
  private assertFrozenModel(instance:PluginInstanceView,identity:string){const profile=instance.configuration.modelProfileId;if(typeof profile!=='string')throw new StoreError('Choose the Hindsight model profile',409);const key=instance.id+':'+identity,row=this.plugins.store.db.prepare('SELECT json FROM memory_provider_model_snapshots WHERE id=?').get(key);if(row&&hindsightModelFingerprint(JSON.parse(String(row.json)))!==hindsightModelFingerprint(this.models.select('memory',profile).settings))throw new StoreError('The model profile changed; migrate away and create a new verified configuration before using this engine',409);}
  configurationIdentity(id:string,namespace?:MemoryProviderNamespace){return this.configuration(id,namespace).identity;}
  provider(id:string,namespace?:MemoryProviderNamespace){if(this.closed)throw new StoreError('Memory adapters are closing',503);const configuration=this.configuration(id,namespace),instance=configuration.instance,pkg=configuration.package,identity=configuration.identity,key=id+':'+identity,existing=this.providers.get(key);if(existing)return existing;
    if(!pkg.directory||pkg.view.state!=='installed')throw new StoreError('The plugin artifact is unavailable',409);
    this.plugins.releases.verifyInstalled(pkg.directory,pkg.view.source.digest,pkg.manifest,Boolean(pkg.hostAdapter));
    let provider:MemoryProvider;
    if(pkg.hostAdapter==='mote.mem0@1'){
      const {embeddingBaseUrl,embeddingModel,embeddingDimension,embeddingSecretReference}=instance.configuration;
      if(typeof embeddingBaseUrl!=='string'||typeof embeddingModel!=='string'||typeof embeddingDimension!=='number')throw new StoreError('Configure the Mem0 embedding connection first',409);
      const directory=join(this.directory,id,'configuration-'+sha256(identity)),url=new URL(embeddingBaseUrl),loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);let secret:string|undefined,embeddingUnavailable:Error|undefined;
      try{secret=this.secret(embeddingSecretReference);}catch(error){
        // Only an already initialized fixed local SDK store can retain literal
        // history after its exact credential profile is deleted. No default or
        // replacement profile is selected, and embedding methods stay fenced.
        if(!(error instanceof EmbeddingCredentialUnavailableError)&&(!(error instanceof ModelSettingsError)||error.code!=='model_profile_missing')||!['operations.db','vectors.db','history.db'].every(file=>existsSync(join(directory,file))))throw error;
        embeddingUnavailable=error;
      }
      if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback)||!loopback&&!secret&&!embeddingUnavailable)throw new StoreError('Embedding requires loopback HTTP or HTTPS with a credential reference');
      provider=new Mem0MemoryProvider({directory,embedding:{baseUrl:embeddingBaseUrl,model:embeddingModel,dimension:embeddingDimension,apiKey:secret??(embeddingUnavailable?'unused-local-reader':'loopback-embedding')}},{embeddingUnavailable,assertEmbeddingAuthority:()=>{if(this.secret(embeddingSecretReference)!==secret)throw new StoreError('Embedding credentials changed; reopen this fixed configuration before embedding work',409);}});
    }else if(pkg.hostAdapter==='mote.hindsight@1'){
      const profile=instance.configuration.modelProfileId;if(typeof profile!=='string')throw new StoreError('Choose the Hindsight model profile',409);
      const prior=this.plugins.store.db.prepare('SELECT json FROM memory_provider_model_snapshots WHERE id=?').get(key);let current:ModelSettings|undefined;
      try{current=this.models.select('memory',profile).settings;}catch(error){if(!prior||!(error instanceof ModelSettingsError)||error.code!=='model_profile_missing')throw error;}
      // A retained literal reader/eraser needs its fixed semantic descriptor,
      // not a currently available inference account. Missing credentials never
      // authorize a replacement profile: semantic work still asserts the exact
      // approved profile immediately before every model request.
      const snapshot=prior?JSON.parse(String(prior.json)) as ModelSettings:{...structuredClone(current!),apiKey:'',headers:{}},settings={...snapshot,apiKey:current?.apiKey??'',headers:current?.headers??{}};
      if(!prior){const json=JSON.stringify(snapshot);this.plugins.store.reserveMetadata(Buffer.byteLength(json));this.plugins.store.db.prepare('INSERT INTO memory_provider_model_snapshots VALUES(?,?)').run(key,json);}
      provider=createHindsightEngine({directory:join(this.directory,id,'configuration-'+sha256(identity)),instanceId:id,configurationIdentity:identity,settings,codex:this.options.codex,runModel:this.options.runModelFor?.(settings),assertModelAuthority:request=>{this.assertFrozenModel(instance,identity);return this.options.assertModelAuthority?.(settings,request);},onUsage:(usage,request)=>this.options.onUsage?.(settings,usage,request),onRequestStarted:request=>this.options.onRequestStarted?.(settings,request),onRequestFinished:request=>this.options.onRequestFinished?.(request)});
    }
    else provider=new WorkerMemoryProvider(this.plugins.runtimeFactory?.(pkg,instance)??new WorkerPluginRuntime(join(pkg.directory,pkg.manifest.entry),instance.configuration,pkg.directory));
    this.providers.set(key,provider);return provider;
  }
  private async restart(id:string){const key=id+':'+this.plugins.configurationIdentity(id),prior=this.providers.get(key);this.providers.delete(key);await prior?.close();await this.plugins.resetRuntime(id);return this.provider(id);}
  async probe(id:string,signal:AbortSignal){const pkg=this.plugins.packageForInstance(id),provider=await this.restart(id),namespace={ownerId:'mote-owner',instanceId:id,bindingRevision:1};signal.throwIfAborted();
    if(provider instanceof HindsightEngine)this.assertFrozenModel(this.plugins.instanceView(id),this.plugins.configurationIdentity(id));
    const health=provider instanceof HindsightEngine?await provider.probe(signal):pkg.hostAdapter?await provider.recover({namespace}):await probeMemoryProvider({provider,restart:()=>this.restart(id),namespace,providerId:pkg.manifest.id,version:pkg.manifest.version,signal});signal.throwIfAborted();
    return {capabilities:pkg.manifest.capabilities.map(capability=>{
      if(capability==='engine'&&pkg.hostAdapter!=='mote.hindsight@1')return {id:capability,state:'unsupported' as const,reason:'The third-party worker ABI supports repository and retrieval; engine execution is not implemented'};
      const verified=health.ready&&(capability==='repository'?health.verified.persistentCrud&&health.verified.immutableRecords&&health.verified.idempotentReplay:capability==='retrieval'?health.verified.scopedRetrieval:health.verified.persistentCrud&&health.verified.scopedRetrieval&&health.verified.immutableRecords&&health.verified.idempotentReplay);
      return {id:capability,state:verified?'verified' as const:'unknown' as const,reason:verified?undefined:'The actual provider probe did not complete'};
    }),issues:health.problems};
  }
  engine(id:string,namespace?:MemoryProviderNamespace){const configuration=this.configuration(id,namespace),provider=this.provider(id,namespace);if(!(provider instanceof HindsightEngine))throw new StoreError('The bound provider is not an engine',409);this.assertFrozenModel(configuration.instance,configuration.identity);return provider;}
  async discardPrepared(input:{namespace:MemoryProviderNamespace;configurationIdentity:string;opId:string;phase:'extract'|'integrate'}){const configuration=this.configuration(input.namespace.instanceId,input.namespace);if(configuration.identity!==input.configurationIdentity)throw new StoreError('Native cleanup configuration differs from its admitted operation',409);const provider=this.provider(input.namespace.instanceId,input.namespace);if(!(provider instanceof HindsightEngine))throw new StoreError('The retained native Memory engine requires recovery',503);await provider.discardPrepared(input);}
  async erasePreparedEvidence(evidenceIds:readonly string[]){const configurations=this.plugins.store.db.prepare('SELECT json FROM memory_provider_configurations').all().map(row=>JSON.parse(String(row.json)) as ProviderConfiguration),seen=new Set<string>();for(const value of configurations){const key=value.instance.id+':'+value.identity;if(seen.has(key)||value.package.hostAdapter!=='mote.hindsight@1')continue;seen.add(key);const provider=this.provider(value.instance.id,value.namespace);if(!(provider instanceof HindsightEngine))throw new StoreError('The retained native Memory engine requires recovery',503);await provider.erasePreparedEvidence(evidenceIds);}}
  async retire(id:string){const values=[...this.providers.entries()].filter(([key])=>key.startsWith(id+':'));for(const [key] of values)this.providers.delete(key);await Promise.allSettled(values.map(([,provider])=>provider.close()));}
  close(){if(this.closing)return this.closing;this.closed=true;return this.closing=(async()=>{await Promise.allSettled([...this.providers.values()].map(provider=>provider.close()));this.providers.clear();})();}
}
