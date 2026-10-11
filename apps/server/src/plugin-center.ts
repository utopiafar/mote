import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import type {PluginCenterView,PluginInstanceView,PluginPackageView,PluginCapability} from '@mote/shared';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {GitHubPluginReleases,type PluginManifest,type ResolvedPluginRelease} from './plugin-release.js';
import {WorkerPluginRuntime,type PluginRuntime} from './plugin-runtime.js';
import {memoryControlCommandSchema} from './memory-automation.js';
import {sha256,StoreError,type Store} from './store.js';

const configurationSchema=z.record(z.union([z.string(),z.number().finite(),z.boolean()]));
const instanceSchema=z.object({name:z.string().trim().min(1).max(160),scope:z.literal('default'),configuration:configurationSchema,expectedRevision:z.number().int().positive(),operationId:z.string().uuid()}).strict();
export type StoredPackage={view:PluginPackageView;manifest:PluginManifest;directory?:string;previewId:string;hostAdapter?:ResolvedPluginRelease['hostAdapter']};
type StoredInstance={view:PluginInstanceView;configurationId?:string;stepId?:string};
const healthSchema=z.object({capabilities:z.array(z.object({id:z.string(),state:z.enum(['verified','unsupported','unknown']),reason:z.string().optional()}).strict()),issues:z.array(z.string()).default([])}).strict();

/** Installation, configuration and runtime admission are independent durable
 * records. All work uses the host ExecutionEngine and survives a host restart. */
export class PluginCenter {
  private runtimes=new Map<string,PluginRuntime>();
  private disposeHandlers:(()=>Promise<void>)[]=[];
  references:(instanceId:string)=>string[]=()=>[];
  admissionChanged?:(instanceId:string,enabled:boolean)=>void;
  retired?:(instanceId:string)=>void;
  runtimeFactory?:(pkg:StoredPackage,instance:PluginInstanceView)=>PluginRuntime;
  configurationAllowed?:(field:PluginManifest['configuration'][number],value:string|number|boolean)=>boolean;
  probe?:(instanceId:string,signal:AbortSignal)=>Promise<{capabilities:PluginCapability[];issues:string[]}>;
  constructor(readonly store:Store,readonly executor:ExecutionEngine,readonly releases:GitHubPluginReleases){
    store.db.exec(`CREATE TABLE IF NOT EXISTS plugin_center(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO plugin_center VALUES(1,1);
      CREATE TABLE IF NOT EXISTS plugin_release_previews(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_packages(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_instances(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_retired_packages(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_retired_instances(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);`);
    this.disposeHandlers.push(executor.register({kind:'plugin.install',pool:'plugin-control',concurrency:()=>1,
      validate:step=>Boolean(this.package(String(step.input.packageId))?.view.state==='installing'),
      execute:async(step,signal)=>{const value=this.preview(String(step.input.previewId));const directory=await releases.install(value);if(signal.aborted)throw new ExecutionFailure('stale','plugin_install_cancelled');return directory;},
      commit:(step,result)=>{const pkg=this.package(String(step.input.packageId));pkg.directory=String(result);pkg.view.state='installed';pkg.view.observed='installed';pkg.view.issues=[];this.savePackage(pkg);this.bump();},
      project:step=>{if(['failed','blocked','stale','cancelled'].includes(step.state)){const pkg=this.package(String(step.input.packageId));pkg.view.state='failed';pkg.view.observed=step.state;pkg.view.issues=[step.error??'plugin_install_failed'];this.savePackage(pkg);}},
      classify:()=>new ExecutionFailure('blocked','plugin_install_requires_attention'),
    }));
    this.disposeHandlers.push(executor.register({kind:'plugin.check',pool:'plugin-control',concurrency:()=>1,timeoutMs:3600000,
      validate:step=>{const instance=this.instance(String(step.input.instanceId));return instance.view.revision===step.input.revision&&instance.stepId===step.id;},
      execute:async(step,signal)=>healthSchema.parse(this.probe?await this.probe(String(step.input.instanceId),signal):await this.runtime(String(step.input.instanceId)).call('health',{namespace:{ownerId:'mote-owner',instanceId:String(step.input.instanceId),bindingRevision:1}},signal)),
      commit:(step,result)=>{const instance=this.instance(String(step.input.instanceId)),health=healthSchema.parse(result),pkg=this.package(instance.view.packageId);
        instance.view.capabilities=pkg.manifest.capabilities.map(id=>health.capabilities.find(capability=>capability.id===id)??{id,state:'unknown',reason:'The runtime did not verify this capability'});
        instance.view.issues=health.issues;instance.view.observed=health.issues.length?'blocked':'ready';instance.view.revision++;delete instance.stepId;this.saveInstance(instance);this.bump();},
      project:step=>{if(['failed','blocked','stale','cancelled'].includes(step.state)){const instance=this.instance(String(step.input.instanceId));if(instance.stepId!==step.id)return;instance.view.observed='blocked';instance.view.issues=[step.error??'plugin_check_failed'];instance.view.capabilities=instance.view.capabilities.map(value=>({...value,state:'unknown',reason:'Capability check did not complete'}));this.saveInstance(instance);}},
      classify:()=>new ExecutionFailure('blocked','plugin_check_requires_attention'),
    }));
  }
  revision(){return Number(this.store.db.prepare('SELECT revision FROM plugin_center WHERE id=1').get()!.revision);}
  private bump(){this.store.db.prepare('UPDATE plugin_center SET revision=revision+1 WHERE id=1').run();}
  private package(id:string):StoredPackage{const row=this.store.db.prepare('SELECT json FROM plugin_packages WHERE id=? UNION ALL SELECT json FROM plugin_retired_packages WHERE id=? LIMIT 1').get(id,id);if(!row)throw new StoreError('Plugin package not found',404);return JSON.parse(String(row.json));}
  private preview(id:string):ResolvedPluginRelease{const row=this.store.db.prepare('SELECT json FROM plugin_release_previews WHERE id=?').get(id);if(!row)throw new StoreError('Resolve the plugin release again before installing',409);return JSON.parse(String(row.json));}
  private instance(id:string):StoredInstance{const row=this.store.db.prepare('SELECT json FROM plugin_instances WHERE id=? UNION ALL SELECT json FROM plugin_retired_instances WHERE id=? LIMIT 1').get(id,id);if(!row)throw new StoreError('Plugin instance not found',404);return JSON.parse(String(row.json));}
  private savePackage(value:StoredPackage){const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('INSERT INTO plugin_packages VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.view.id,json);}
  private saveInstance(value:StoredInstance){const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('INSERT INTO plugin_instances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.view.id,json);}
  private command(kind:string,input:{operationId:string;expectedRevision:number},revision:()=>number,apply:()=>void){
    const fingerprint=sha256(JSON.stringify({kind,...input})),db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{const prior=db.prepare('SELECT fingerprint FROM plugin_commands WHERE id=?').get(input.operationId);
      if(prior){if(prior.fingerprint!==fingerprint)throw new StoreError('Plugin command identity conflict',409);db.exec('COMMIT');return false;}
      if(input.expectedRevision!==revision())throw new StoreError('Plugin settings changed; refresh before applying',409);
      apply();this.store.reserveMetadata(256);db.prepare('INSERT INTO plugin_commands VALUES(?,?)').run(input.operationId,fingerprint);this.bump();db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    void this.executor.tick().catch(()=>{});
    return true;
  }
  view():PluginCenterView{
    const instances=this.store.db.prepare('SELECT id FROM plugin_instances ORDER BY rowid').all().map(row=>this.instanceView(String(row.id))),packages=this.store.db.prepare('SELECT json FROM plugin_packages ORDER BY rowid').all().map(row=>JSON.parse(String(row.json)) as StoredPackage);
    return {revision:this.revision(),installation:{supported:true,runtime:'worker',restartRequired:false},packages:packages.map(pkg=>({...pkg.view,configurationSchema:pkg.manifest.configuration,instanceIds:instances.filter(instance=>instance.packageId===pkg.view.id).map(instance=>instance.id),allowedActions:pkg.view.state==='installed'?['configure',...(!instances.some(instance=>instance.packageId===pkg.view.id&&(instance.desired||this.references(instance.id).length))?['uninstall' as const]:[])]:pkg.view.state==='failed'?['uninstall']:[]})),instances,catalog:[{repository:'mem0ai/mem0',name:'Mem0',description:'Pinned ts-v3.3.1 with the bundled Mote storage/retrieval adapter'},{repository:'vectorize-io/hindsight',name:'Hindsight',description:'Pinned v0.10.2; controlled engine capability verification required'}]};
  }
  instanceView(id:string):PluginInstanceView{const {view,stepId}=this.instance(id),references=this.references(id),pending=stepId&&['waiting','running'].includes(this.executor.get(stepId)?.state??'');
    if(!this.store.db.prepare('SELECT 1 FROM plugin_instances WHERE id=?').get(id))return {...view,desired:false,observed:'disabled',issues:references,allowedActions:[]};
    return {...view,issues:[...view.issues,...references],allowedActions:pending?[]:[...(!view.desired&&!references.length?['configure' as const,'check' as const]:[]),...(view.desired?['disable' as const]:!view.issues.length&&view.capabilities.some(value=>value.state==='verified')?['enable' as const]:[])]};
  }
  configurationIdentity(id:string){return this.instance(id).configurationId??sha256(JSON.stringify(this.instance(id).view.configuration));}
  async resetRuntime(id:string){if(this.references(id).length||this.instance(id).view.desired)throw new StoreError('A retained or enabled runtime cannot be restarted for a probe',409);const runtime=this.runtimes.get(id);this.runtimes.delete(id);await runtime?.close();}
  packageForInstance(id:string){const value=this.package(this.instance(id).view.packageId);return {...value,directory:join(this.releases.directory,value.view.source.digest)};}
  async resolve(raw:unknown){const input=z.object({repository:z.string().min(1).max(2000),tag:z.string().min(1).max(200).optional()}).strict().parse(raw),value=await this.releases.resolve(input),json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('INSERT INTO plugin_release_previews VALUES(?,?)').run(value.preview.id,json);return value.preview;}
  install(raw:unknown){const input=memoryControlCommandSchema.extend({previewId:z.string().uuid()}).strict().parse(raw);
    this.command('install',input,()=>this.revision(),()=>{const release=this.preview(input.previewId),id=release.manifest.id+'@'+release.preview.source.digest;
      if(this.store.db.prepare('SELECT 1 FROM plugin_packages WHERE id=?').get(id)){
        const existing=this.package(id);if(existing.view.state!=='failed')return;
        existing.view.state='installing';existing.view.observed='installing';existing.view.issues=[];existing.view.operationId=input.operationId;existing.previewId=input.previewId;this.savePackage(existing);
        this.executor.enqueue(input.operationId,'plugin.install',{packageId:id,previewId:input.previewId},{id:'plugin-install:'+input.operationId});return;
      }
      this.savePackage({previewId:input.previewId,manifest:release.manifest,hostAdapter:release.hostAdapter,view:{id,name:release.manifest.name,version:release.manifest.version,source:release.preview.source,runtime:release.preview.runtime,state:'installing',desired:false,observed:'installing',issues:[],instanceIds:[],allowedActions:[],operationId:input.operationId}});
      this.executor.enqueue(input.operationId,'plugin.install',{packageId:id,previewId:input.previewId},{id:'plugin-install:'+input.operationId});
    });return this.view();
  }
  private validateConfiguration(manifest:PluginManifest,configuration:Record<string,string|number|boolean>,complete=false){
    if(Object.keys(configuration).some(key=>!manifest.configuration.some(field=>field.id===key)))throw new StoreError('Unknown plugin configuration field');
    for(const field of manifest.configuration){const value=configuration[field.id];if(value===undefined||value===''){if(complete&&field.required)throw new StoreError('A required plugin configuration value is missing');continue;}
      if(field.type==='number'?typeof value!=='number':field.type==='boolean'?typeof value!=='boolean':typeof value!=='string')throw new StoreError('Invalid plugin configuration value');
      if(field.type==='select'&&!field.options?.some(option=>option.value===value))throw new StoreError('Invalid plugin configuration option');
      if(['model-profile','secret-reference'].includes(field.type)&&!this.configurationAllowed?.(field,value))throw new StoreError('The referenced model profile or secret is unavailable');
    }
  }
  configure(id:string|undefined,raw:unknown){const input=instanceSchema.extend({packageId:z.string().min(1).optional()}).parse(raw);if(!id&&!input.packageId)throw new StoreError('Choose an installed plugin package');let resultId=id;
    const applied=this.command(id?'configure:'+id:'create',input,()=>id?this.instance(id).view.revision:this.revision(),()=>{
      if(id&&!this.store.db.prepare('SELECT 1 FROM plugin_instances WHERE id=?').get(id))throw new StoreError('Plugin instance is uninstalled',409);
      const existing=id?this.instance(id):undefined,packageId=existing?.view.packageId??input.packageId!;if(!this.store.db.prepare('SELECT 1 FROM plugin_packages WHERE id=?').get(packageId))throw new StoreError('Plugin package is uninstalled',409);const pkg=this.package(packageId);if(pkg.view.state!=='installed')throw new StoreError('Wait for plugin installation to complete',409);
      if(existing&&(existing.view.desired||this.references(id!).length))throw new StoreError('Disable and migrate the instance before configuring it',409);
      this.validateConfiguration(pkg.manifest,input.configuration);resultId=id??input.operationId;
      const capabilities:PluginCapability[]=pkg.manifest.capabilities.map(capability=>({id:capability,state:'unknown',reason:'Requires a capability check'}));
      const configuration=Object.fromEntries(Object.entries(input.configuration).filter(([key])=>pkg.manifest.configuration.find(field=>field.id===key)?.type!=='secret-reference'));
      // Only opaque references are persisted, never plaintext credentials.
      this.saveInstance({configurationId:input.operationId,view:{id:resultId!,packageId:pkg.view.id,name:input.name,scope:input.scope,revision:(existing?.view.revision??0)+1,configurationSchema:pkg.manifest.configuration,configuration:{...configuration,...Object.fromEntries(Object.entries(input.configuration).filter(([key])=>pkg.manifest.configuration.find(field=>field.id===key)?.type==='secret-reference'))},secretStatus:Object.fromEntries(pkg.manifest.configuration.filter(field=>field.type==='secret-reference').map(field=>[field.id,Boolean(input.configuration[field.id])])),capabilities,desired:false,observed:'configured',issues:[],allowedActions:[]}});
    });if(applied&&id){const old=this.runtimes.get(id);this.runtimes.delete(id);void old?.close().catch(()=>{});}return this.instanceView(resultId??input.operationId);
  }
  action(id:string,kind:'check'|'enable'|'disable',raw:unknown){const input=memoryControlCommandSchema.parse(raw);
    this.command(kind+':'+id,input,()=>this.instance(id).view.revision,()=>{const instance=this.instance(id),view=this.instanceView(id);if(!view.allowedActions.includes(kind))throw new StoreError('This plugin action is unavailable in its current state',409);
      if(kind==='check'){this.validateConfiguration(this.package(instance.view.packageId).manifest,instance.view.configuration,true);instance.view.observed='checking';instance.view.issues=[];instance.stepId='plugin-check:'+input.operationId;instance.view.revision++;this.saveInstance(instance);this.executor.enqueue(input.operationId,'plugin.check',{instanceId:id,revision:instance.view.revision},{id:instance.stepId});}
      else{instance.view.desired=kind==='enable';instance.view.observed=kind==='enable'?'ready':this.references(id).length?'draining':'disabled';instance.view.revision++;this.saveInstance(instance);this.admissionChanged?.(id,kind==='enable');}
    });return this.instanceView(id);
  }
  uninstall(id:string,raw:unknown){const input=memoryControlCommandSchema.parse(raw);let retired:string[]=[];const applied=this.command('uninstall:'+id,input,()=>this.revision(),()=>{
    const instances=this.view().instances.filter(value=>value.packageId===id);if(instances.some(value=>value.desired||this.references(value.id).length||value.observed==='checking'))throw new StoreError('Disable and migrate the plugin before uninstalling it',409);
    const pkg=this.package(id);if(pkg.view.state==='installing')throw new StoreError('Wait for installation to settle before uninstalling',409);
    for(const instance of instances){this.store.db.prepare('INSERT OR REPLACE INTO plugin_retired_instances SELECT id,json FROM plugin_instances WHERE id=?').run(instance.id);this.store.db.prepare('DELETE FROM plugin_instances WHERE id=?').run(instance.id);}this.store.db.prepare('INSERT OR REPLACE INTO plugin_retired_packages SELECT id,json FROM plugin_packages WHERE id=?').run(id);this.store.db.prepare('DELETE FROM plugin_packages WHERE id=?').run(id);retired=instances.map(instance=>instance.id);
    // Immutable code remains cached; uninstall never destroys retained Memory.
  });if(applied)for(const id of retired){const runtime=this.runtimes.get(id);this.runtimes.delete(id);void runtime?.close().catch(()=>{});this.retired?.(id);}return this.view();}
  runtime(id:string){const existing=this.runtimes.get(id);if(existing)return existing;const instance=this.instance(id).view,pkg=this.packageForInstance(id);if(!pkg.directory||pkg.view.state!=='installed')throw new StoreError('The plugin artifact is unavailable',409);
    this.releases.verifyInstalled(pkg.directory,pkg.view.source.digest,pkg.manifest,Boolean(pkg.hostAdapter));
    const runtime=this.runtimeFactory?.(pkg,instance)??new WorkerPluginRuntime(join(pkg.directory,pkg.manifest.entry),instance.configuration,pkg.directory);this.runtimes.set(id,runtime);return runtime;
  }
  async close(){for(const dispose of this.disposeHandlers)await dispose();await Promise.allSettled([...this.runtimes.values()].map(runtime=>runtime.close()));this.runtimes.clear();}
}
