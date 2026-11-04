import {calendarPluginCapabilitySchema,type ActionPluginProvider} from '@mote/shared';
import {EXECUTION_POLICIES} from './execution-policy.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import type {PluginBuildView,PluginCenterView,PluginInstanceView,PluginPackageView,PluginCapability} from '@mote/shared';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {GitHubPluginReleases,type PluginManifest,type ResolvedPluginRelease} from './plugin-release.js';
import {HostedPluginRuntime,WorkerPluginRuntime,type PluginRuntime} from './plugin-runtime.js';
import {memoryControlCommandSchema} from './memory-automation.js';
import {sha256,StoreError,type Store} from './store.js';
import {PluginControlStore,type BuildInstance,type BuildInstanceRecord,type BuildPackageRecord,type BuildSelection} from './plugins/plugin-control-store.js';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,ScopeIdentity} from '@mote/plugin-api/contracts';
import {PluginHostError,type PluginHost,type PluginHandle,type HostPluginContext} from '@mote/plugin-host';
import {centralServices} from './plugins/central-contracts.js';

const configurationSchema=z.record(z.union([z.string(),z.number().finite(),z.boolean()]));
const instanceSchema=z.object({name:z.string().trim().min(1).max(160),scope:z.literal('default'),configuration:configurationSchema,expectedRevision:z.number().int().positive(),operationId:z.string().uuid()}).strict();
export type StoredPackage=BuildPackageRecord;
type StoredInstance=BuildInstanceRecord;
type StoredBuild=BuildInstance&{package?:StoredPackage;instance?:StoredInstance};
const healthSchema=z.object({capabilities:z.array(z.object({id:z.string(),state:z.enum(['verified','unsupported','unknown']),reason:z.string().optional()}).strict()),issues:z.array(z.string()).default([])}).strict();

const sameScope=(a:ScopeIdentity,b:ScopeIdentity)=>a.packageId===b.packageId&&a.installationId===b.installationId&&a.instanceId===b.instanceId&&a.activationId===b.activationId&&a.host.id===b.host.id&&a.host.kind===b.host.kind;
const sameBinding=(a:ServiceBinding,b:ServiceBinding)=>a.revision===b.revision&&a.service.id===b.service.id&&a.service.apiVersion===b.service.apiVersion&&a.provider.contributionId===b.provider.contributionId&&sameScope(a.provider.scope,b.provider.scope);

/** One durable build/instance model owns downloaded worker packages, their
 * configured instances and trusted native builds. Installation, configuration
 * and runtime admission stay separate facts; all work uses the host
 * ExecutionEngine and survives a host restart. */
export class PluginCenter {
  readonly control:PluginControlStore;
  private accepting=true;
  private closed=false;
  private readonly builds=new Map<string,TrustedPluginBuild>();
  private readonly buildHandles=new Map<string,{handle:PluginHandle;selection:BuildSelection}>();
  private readonly applying=new Map<string,Promise<void>>();
  private restored=false;
  private closing?:Promise<void>;
  private runtimes=new Map<string,PluginRuntime>();
  private disposeHandlers:(()=>Promise<void>)[]=[];
  references:(instanceId:string)=>string[]=()=>[];
  admissionChanged?:(instanceId:string,enabled:boolean)=>void;
  retired?:(instanceId:string)=>void;
  runtimeFactory?:(pkg:StoredPackage,instance:PluginInstanceView)=>PluginRuntime;
  configurationAllowed?:(field:PluginManifest['configuration'][number],value:string|number|boolean)=>boolean;
  probe?:(instanceId:string,signal:AbortSignal)=>Promise<{capabilities:PluginCapability[];issues:string[]}>;
  constructor(readonly store:Store,readonly executor:ExecutionEngine,readonly releases:GitHubPluginReleases,private readonly hostOwner?:{host:PluginHost;binding:()=>ServiceBinding;assertCurrent?:()=>void;hostDependencies?:readonly TrustedHostDependency[]}){
    this.control=new PluginControlStore(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS plugin_release_previews(id TEXT PRIMARY KEY,json TEXT NOT NULL);`);
    store.registerStorage('plugin-control',{plugin_release_previews:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128'});
    this.disposeHandlers.push(executor.register({kind:'plugin.install',pool:'plugin-control',concurrency:()=>1,policy:EXECUTION_POLICIES.control,admit:()=>this.admit(),
      validate:step=>Boolean(this.package(String(step.input.packageId))?.view.state==='installing'),
      execute:async(step,signal)=>{const value=this.preview(String(step.input.previewId));const directory=await releases.install(value);if(signal.aborted)throw new ExecutionFailure('stale','plugin_install_cancelled');return directory;},
      commit:(step,result)=>{const pkg=this.package(String(step.input.packageId));pkg.directory=String(result);pkg.view.state='installed';pkg.view.observed='installed';pkg.view.issues=[];this.savePackage(pkg);this.bump();},
      project:step=>{if(['failed','blocked','stale','cancelled'].includes(step.state)){const pkg=this.package(String(step.input.packageId));pkg.view.state='failed';pkg.view.observed=step.state;pkg.view.issues=[step.error??'plugin_install_failed'];this.savePackage(pkg);}},
      classify:()=>new ExecutionFailure('blocked','plugin_install_requires_attention'),
    }));
    this.disposeHandlers.push(executor.register({kind:'plugin.check',pool:'plugin-control',concurrency:()=>1,policy:EXECUTION_POLICIES.control,timeoutMs:3600000,admit:()=>this.admit(),
      validate:step=>{const instance=this.instance(String(step.input.instanceId));return instance.view.revision===step.input.revision&&instance.stepId===step.id;},
      execute:async(step,signal)=>{
        const id=String(step.input.instanceId),pkg=this.packageForInstance(id);
        this.releases.verifyInstalled(pkg.directory!,pkg.view.source.digest,pkg.manifest,Boolean(pkg.hostAdapter));
        const actions=(pkg.manifest.actionCapabilities??[]).map(value=>{calendarPluginCapabilitySchema.parse(value);return {id:value.id,state:'verified' as const,reason:'Host contract verified; device permission and owner execution grant are still required'};});
        const health=pkg.manifest.capabilities.every(value=>value==='calendar.manage')?{capabilities:[],issues:[]}:healthSchema.parse(this.probe?await this.probe(id,signal):await this.runtime(id).call('health',{namespace:{ownerId:'mote-owner',instanceId:id,bindingRevision:1}},signal));
        signal.throwIfAborted();return {...health,capabilities:[...health.capabilities.filter(value=>value.id!=='calendar.manage'),...actions]};
      },
      commit:(step,result)=>{const instance=this.instance(String(step.input.instanceId)),health=healthSchema.parse(result),pkg=this.package(instance.view.packageId);
        instance.view.capabilities=pkg.manifest.capabilities.map(id=>health.capabilities.find(capability=>capability.id===id)??{id,state:'unknown',reason:'The runtime did not verify this capability'});
        instance.view.issues=health.issues;instance.view.observed=health.issues.length||instance.view.capabilities.some(value=>value.state==='unknown')?'blocked':'ready';instance.view.revision++;delete instance.stepId;this.saveInstance(instance);this.bump();},
      project:step=>{if(['failed','blocked','stale','cancelled'].includes(step.state)){const instance=this.instance(String(step.input.instanceId));if(instance.stepId!==step.id)return;instance.view.observed='blocked';instance.view.issues=[step.error??'plugin_check_failed'];instance.view.capabilities=instance.view.capabilities.map(value=>({...value,state:'unknown',reason:'Capability check did not complete'}));this.saveInstance(instance);}},
      classify:()=>new ExecutionFailure('blocked','plugin_check_requires_attention'),
    }));
  }
  private assertCurrent(){if(!this.accepting)throw new StoreError('Plugin center is quiescing',503);this.hostOwner?.assertCurrent?.();}
  private admit(){
    if(!this.accepting)return new ExecutionFailure('waiting','plugin_control_quiescing',1000);
    if(this.hostOwner){
      try{const binding=this.hostOwner.binding();if(!this.hostOwner.host.snapshot().contributions.some(value=>sameScope(value.identity.scope,binding.provider.scope)&&value.identity.contributionId===binding.provider.contributionId&&value.availability.state==='active'))return new ExecutionFailure('waiting','plugin_control_not_active',1000);}
      catch{return new ExecutionFailure('waiting','plugin_control_not_active',1000);}
    }
  }
  revision(){return this.control.revision();}
  private bump(){this.control.bump();}
  commandReceipt(operationId:string){return this.control.receipt(operationId);}
  private buildRecords():StoredBuild[]{return this.control.builds() as StoredBuild[];}
  private packageBuild(id:string){return this.buildRecords().find(record=>record.kind==='package'&&record.package?.view.id===id);}
  private instanceBuild(id:string){return this.buildRecords().find(record=>record.kind==='instance'&&record.instance?.view.id===id);}
  private package(id:string):StoredPackage{const record=this.buildRecords().find(value=>value.id===id)??this.packageBuild(id);if(!record?.package)throw new StoreError('Plugin package not found',404);return record.package;}
  private preview(id:string):ResolvedPluginRelease{const row=this.store.db.prepare('SELECT json FROM plugin_release_previews WHERE id=?').get(id);if(!row)throw new StoreError('Resolve the plugin release again before installing',409);return JSON.parse(String(row.json));}
  private instance(id:string):StoredInstance{const record=this.instanceBuild(id)??this.buildRecords().find(value=>value.id===id);if(!record?.instance)throw new StoreError('Plugin instance not found',404);return record.instance;}
  private saveBuild(value:StoredBuild){this.control.saveBuild(value);}
  private savePackage(value:StoredPackage){const existing=this.packageBuild(value.view.id),observed=value.view.state==='installed'?'stopped':value.view.state==='failed'?'blocked':'queued';
    this.saveBuild({id:value.view.id,packageId:value.view.id,version:value.manifest.version,installationId:value.installationId,revision:existing?.revision??1,desired:null,retired:false,
      observed,blockers:value.view.issues,operationId:existing?.operationId??value.view.operationId??'package',kind:'package',package:value});}
  private saveInstance(value:StoredInstance){const existing=this.instanceBuild(value.view.id),pkg=this.package(value.view.packageId),desired=value.view.desired;
    const observed=value.view.observed==='checking'?'starting':value.view.issues.length||value.view.observed==='blocked'?'blocked':value.view.observed==='draining'?'draining':desired?'active':'stopped';
    const selection={packageId:value.view.packageId,version:pkg.manifest.version,configurationRevision:value.view.revision};
    const activeSelection=desired?selection:value.view.observed==='draining'?existing?.activeSelection??existing?.desired??null:null;
    this.saveBuild({id:value.view.id,packageId:value.view.packageId,version:pkg.manifest.version,installationId:existing?.installationId??pkg.installationId,revision:value.view.revision,
      desired:desired?selection:null,retired:existing?.retired??false,activeSelection,
      observed,blockers:value.view.issues,operationId:existing?.operationId??value.configurationId??value.view.id,kind:'instance',instance:value});}
  private command(kind:string,input:{operationId:string;expectedRevision:number},revision:()=>number,apply:()=>void){
    this.assertCurrent();
    const applied=this.control.command(kind,input,revision,apply);
    if(applied)void this.executor.tick().catch(()=>{});
    return applied;
  }
  view():PluginCenterView{
    const records=this.buildRecords(),instances=records.filter(record=>record.kind==='instance'&&!record.retired).map(record=>this.instanceView(record.instance!.view.id)),
      packages=records.filter(record=>record.kind==='package'&&!record.retired).map(record=>record.package!);
    return {revision:this.revision(),installation:{supported:true,runtime:'worker',restartRequired:false},packages:packages.map(pkg=>({...pkg.view,configurationSchema:pkg.manifest.configuration,instanceIds:instances.filter(instance=>instance.packageId===pkg.view.id).map(instance=>instance.id),allowedActions:pkg.view.state==='installed'?['configure',...(!instances.some(instance=>instance.packageId===pkg.view.id&&(instance.desired||this.references(instance.id).length))?['uninstall' as const]:[])]:pkg.view.state==='failed'?['uninstall']:[]})),instances,builds:this.buildViews(),catalog:[{repository:'mem0ai/mem0',name:'Mem0',description:'Pinned ts-v3.3.1 with the bundled Mote storage/retrieval adapter'},{repository:'vectorize-io/hindsight',name:'Hindsight',description:'Pinned v0.10.2; controlled engine capability verification required'}]};
  }
  hostCapabilities(){return {
    memoryWorker:{runtime:'worker',factoryExports:['createMemoryProvider'],methods:['health','put','read','remove','search','export'],lifecycle:['close'],supportedCapabilities:['repository','retrieval']},
  };}
  instanceView(id:string):PluginInstanceView{const record=this.instanceBuild(id),{view,stepId}=this.instance(id),references=this.references(id),pending=stepId&&['waiting','running'].includes(this.executor.get(stepId)?.state??'');
    if(!record||record.retired)return {...view,desired:false,observed:'disabled',issues:references,allowedActions:[]};
    return {...view,issues:[...view.issues,...references],allowedActions:pending?[]:[...(!view.desired&&!references.length?['configure' as const,'check' as const]:[]),...(view.desired?['disable' as const]:!view.issues.length&&view.capabilities.every(value=>value.state!=='unknown')&&view.capabilities.some(value=>value.state==='verified')?['enable' as const]:[])]};
  }
  /** Only installed, checked, enabled instances supply execution declarations. */
  actionProviders():ActionPluginProvider[]{
    if(this.closed)return [];
    return this.view().instances.flatMap(instance=>{
      if(!instance.desired||instance.observed!=='ready'||instance.issues.length)return [];
      const pkg=this.packageForInstance(instance.id);if(pkg.view.state!=='installed')return [];
      try{this.releases.verifyInstalled(pkg.directory!,pkg.view.source.digest,pkg.manifest,Boolean(pkg.hostAdapter));}catch{return [];}
      return (pkg.manifest.actionCapabilities??[]).filter(capability=>calendarPluginCapabilitySchema.safeParse(capability).success&&instance.capabilities.some(value=>value.id===capability.id&&value.state==='verified')).map(capability=>({
        identity:{packageId:pkg.view.id,releaseDigest:pkg.view.source.digest,instanceId:instance.id,instanceRevision:instance.revision,capabilityDigest:sha256(JSON.stringify(calendarPluginCapabilitySchema.parse(capability)))},name:instance.name,capability,
      }));
    });
  }
  /** Host-issued data namespace, distinct from the default domain and each activation. */
  instanceIdentity(id:string){const pkg=this.packageForInstance(id);if(!pkg.installationId)throw new StoreError('Plugin installation identity is unavailable',409);return Object.freeze({packageId:pkg.manifest.id,installationId:pkg.installationId,instanceId:id});}
  configurationIdentity(id:string){return this.instance(id).configurationId??sha256(JSON.stringify(this.instance(id).view.configuration));}
  async resetRuntime(id:string){if(this.references(id).length||this.instance(id).view.desired)throw new StoreError('A retained or enabled runtime cannot be restarted for a probe',409);const runtime=this.runtimes.get(id);this.runtimes.delete(id);await runtime?.close();}
  packageForInstance(id:string){const value=this.package(this.instance(id).view.packageId);return {...value,directory:join(this.releases.directory,value.view.source.digest)};}
  async resolve(raw:unknown){this.assertCurrent();const input=z.object({repository:z.string().min(1).max(2000),tag:z.string().min(1).max(200).optional()}).strict().parse(raw),value=await this.releases.resolve(input);this.assertCurrent();const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('INSERT INTO plugin_release_previews VALUES(?,?)').run(value.preview.id,json);return value.preview;}
  install(raw:unknown){const input=memoryControlCommandSchema.extend({previewId:z.string().uuid()}).strict().parse(raw);
    this.command('install',input,()=>this.revision(),()=>{const release=this.preview(input.previewId),id=release.manifest.id+'@'+release.preview.source.digest,prior=this.packageBuild(id);
      if(prior&&!prior.retired){
        const existing=this.package(id);if(existing.view.state!=='failed')return;
        existing.view.state='installing';existing.view.observed='installing';existing.view.issues=[];existing.view.operationId=input.operationId;existing.previewId=input.previewId;this.savePackage(existing);
        this.executor.enqueue(input.operationId,'plugin.install',{packageId:id,previewId:input.previewId},{id:'plugin-install:'+input.operationId});return;
      }
      this.savePackage({installationId:prior?.package?.installationId??randomUUID(),previewId:input.previewId,manifest:release.manifest,hostAdapter:release.hostAdapter,view:{id,name:release.manifest.name,version:release.manifest.version,source:release.preview.source,runtime:release.preview.runtime,state:'installing',desired:false,observed:'installing',issues:[],instanceIds:[],allowedActions:[],operationId:input.operationId}});
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
      if(id&&(!this.instanceBuild(id)||this.instanceBuild(id)!.retired))throw new StoreError('Plugin instance is uninstalled',409);
      const existing=id?this.instance(id):undefined,packageId=existing?.view.packageId??input.packageId!;if(!this.packageBuild(packageId)||this.packageBuild(packageId)!.retired)throw new StoreError('Plugin package is uninstalled',409);const pkg=this.package(packageId);if(pkg.view.state!=='installed')throw new StoreError('Wait for plugin installation to complete',409);
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
    const instances=this.view().instances.filter(value=>value.packageId===id),records=this.buildRecords(),packageRecord=this.packageBuild(id);
    if(!packageRecord||packageRecord.retired)throw new StoreError('Plugin package not found',404);
    if(instances.some(value=>value.desired||this.references(value.id).length||value.observed==='checking'))throw new StoreError('Disable and migrate the plugin before uninstalling it',409);
    const pkg=this.package(id);if(pkg.view.state==='installing')throw new StoreError('Wait for installation to settle before uninstalling',409);
    for(const record of records)if(!record.retired&&(record.id===packageRecord.id||record.kind==='instance'&&record.packageId===id))this.saveBuild({...record,retired:true,activeSelection:null});
    retired=instances.map(instance=>instance.id);
    // Immutable code remains cached; uninstall never destroys retained Memory.
  });if(applied)for(const id of retired){const runtime=this.runtimes.get(id);this.runtimes.delete(id);void runtime?.close().catch(()=>{});this.retired?.(id);}return this.view();}
  runtime(id:string){this.assertCurrent();const existing=this.runtimes.get(id);if(existing)return existing;const runtime=this.runtimeFor(this.packageForInstance(id),this.instance(id).view);this.runtimes.set(id,runtime);return runtime;}
  /** A retained namespace can recreate its exact historical configuration
   * without changing the current build selection. The executable process is
   * still constructed only here, never by an adapter or an HTTP handler. */
  runtimeFor(pkg:StoredPackage,instance:PluginInstanceView){this.assertCurrent();if(!pkg.directory||pkg.view.state!=='installed')throw new StoreError('The plugin artifact is unavailable',409);
    const directory=pkg.directory;this.releases.verifyInstalled(directory,pkg.view.source.digest,pkg.manifest,Boolean(pkg.hostAdapter));
    const create=()=>{
      const actual=this.runtimeFactory?.(pkg,instance)??new WorkerPluginRuntime(join(directory,pkg.manifest.entry),instance.configuration,directory);
      const observed:PluginRuntime={ready:actual.ready?.bind(actual),close:actual.close.bind(actual),call:async(...args)=>{
        try{return await actual.call(...args);}catch(error){
          if(error instanceof StoreError&&error.statusCode===503&&!this.closed&&this.instanceBuild(instance.id)&&!this.instanceBuild(instance.id)!.retired){
            const failed=this.instance(instance.id);failed.view.observed='blocked';failed.view.issues=['plugin_worker_unavailable_reconciliation_required'];failed.view.capabilities=failed.view.capabilities.map(value=>({...value,state:'unknown'}));failed.view.revision++;this.saveInstance(failed);this.bump();
          }
          throw error;
        }
      }};return observed;
    };
    return this.hostOwner?new HostedPluginRuntime(this.hostOwner.host,{...this.instanceIdentity(instance.id),host:this.hostOwner.host.identity,activationId:randomUUID()},this.hostOwner.binding(),create):create();
  }
  /** Fixed build registry only: never accept executable definitions from HTTP,
   * an installed archive or a normal plugin. No synthetic package/digest record. */
  registerBuild(build:TrustedPluginBuild){
    if(this.restored||!this.accepting||!this.hostOwner)throw new StoreError('Build registry is sealed or unavailable',409);
    const key=build.packageId+'@'+build.version;
    if(this.builds.has(key)||build.contribution.runtime!=='host'||!build.contribution.id||!build.packageId||!build.version)throw new StoreError('Invalid or duplicate trusted build',409);
    const contribution=structuredClone(build.contribution),apis=new Set(contribution.provides?.length?contribution.provides.map(port=>port.apiVersion):['1']);
    if(new Set(contribution.provides?.map(port=>port.id)).size!==contribution.provides?.length&&contribution.provides)throw new StoreError('Duplicate declared build port',409);
    if(apis.size!==1)throw new StoreError('A host contribution must use one declared API version',409);
    this.builds.set(key,Object.freeze({...build,contribution,requires:structuredClone(build.requires??[]),optional:structuredClone(build.optional??[])}));
  }
  buildView(id:string){return this.unifiedBuildView(this.control.build(id),id);}
  private unifiedBuildView(value:BuildInstance|undefined,id:string):PluginBuildView{
    if(!value)throw new StoreError('Build instance not found',404);
    const record=value as StoredBuild,worker=record.kind==='package'||record.kind==='instance',pkg=record.package??(worker?this.packageBuild(record.packageId)?.package:undefined),
      instance=record.instance?.view,native=!record.kind||record.kind==='native';
    const owned=this.buildHandles.get(id),live=owned&&!owned.handle.signal.aborted&&Boolean(this.hostOwner)&&this.hostOwner!.host.snapshot().contributions.some(entry=>
      sameScope(entry.identity.scope,owned.handle.identity)&&entry.availability.state==='active');
    const matches=Boolean(live&&JSON.stringify(owned!.selection)===JSON.stringify(record.desired));
    const workerActive=Boolean(worker&&record.activeSelection);
    const active=native?(live?{...owned!.selection,identity:owned!.handle.identity}:null):workerActive?{...record.activeSelection!,identity:this.instanceIdentity(id)}:null;
    const observed=native?(matches?'active':record.observed==='active'?'blocked':record.observed):record.observed;
    return {id:record.id,packageId:record.packageId,installationId:record.installationId,revision:record.revision,desired:record.desired,retired:record.retired,
      observed,blockers:native&&record.observed==='active'&&!live?['activation_unavailable']:record.blockers,operationId:record.operationId,active,
      restartRequired:record.observed==='restart_required',version:record.version??pkg?.manifest.version??this.builds.get(record.packageId+'@'+(record.version??'1.0.0'))?.version??'',
      name:instance?.name??pkg?.manifest.name??id,runtime:worker?'worker':'host',source:pkg?.view.source??null,
      configuration:instance?.configuration??{},configurationSchema:instance?.configurationSchema??pkg?.manifest.configuration??[],
      capabilities:instance?.capabilities??[],issues:instance?.issues??record.blockers,allowedActions:instance?.allowedActions??[],package:record.kind==='package'};
  }
  buildViews(){return this.control.builds().map(value=>this.unifiedBuildView(value,value.id));}
  async selectBuild(id:string,raw:unknown){
    const input=memoryControlCommandSchema.extend({selection:z.object({packageId:z.string().min(1),version:z.string().min(1),configurationRevision:z.number().int().nonnegative()}).strict().nullable()}).strict().parse(raw);
    const prior=this.control.build(id) as StoredBuild|undefined;
    if(prior?.kind==='instance'){
      const selection=input.selection,command=input.expectedRevision!==prior.revision&&input.expectedRevision===this.revision()?{...input,expectedRevision:prior.revision}:input;
      if(selection&&(selection.packageId!==prior.packageId||selection.version!==prior.version))throw new StoreError('Choose the installed build version for this instance',409);
      const applied=this.command('build:'+id,command,()=>this.control.build(id)?.revision??prior.revision,()=>{
        const current=this.control.build(id) as StoredBuild;if(!current?.instance)throw new StoreError('Build instance not found',404);if(current.retired)throw new StoreError('Build instance is retired',409);
        const value=current.instance,references=this.references(id);
        if(selection&&references.length)throw new StoreError('Release retained references before replacement',409);
        const ready=value.view.capabilities.every(capability=>capability.state!=='unknown')&&value.view.capabilities.some(capability=>capability.state==='verified');
        value.view.desired=Boolean(selection);value.view.revision++;value.stepId=undefined;
        value.view.observed=!selection?(references.length?'draining':'disabled'):ready?'ready':'blocked';
        value.view.issues=selection&&!ready?['capability_unverified']:[];
        if(selection)this.validateConfiguration(this.package(value.view.packageId).manifest,value.view.configuration,true);
        this.saveInstance(value);this.admissionChanged?.(id,Boolean(selection));
        const saved=this.instanceBuild(id)!;saved.observed=selection?(ready?'active':'blocked'):references.length?'draining':'stopped';
        saved.desired=selection;this.saveBuild(saved);
      });
      if(!applied)await this.applying.get(id);
      return this.buildView(id);
    }
    if(prior?.kind==='package')throw new StoreError('Choose a configured instance build',409);
    if(!this.hostOwner)throw new StoreError('Trusted build host is unavailable',503);
    const build=input.selection?this.builds.get(input.selection.packageId+'@'+input.selection.version):undefined;
    if(input.selection&&!build)throw new StoreError('Trusted build is not registered',409);
    const running=this.buildHandles.get(id)?.selection;
    const installed=running&&this.builds.get(running.packageId+'@'+running.version);
    const restart=build?.replacement==='restart'||installed?.replacement==='restart';
    const applied=this.command('build:'+id,input,()=>this.control.build(id)?.revision??this.revision(),()=>{
      const previous=this.control.build(id);if(!previous&&!input.selection)throw new StoreError('Build instance not found',404);if(previous?.retired)throw new StoreError('Build instance is retired',409);
      const retained=this.references(id).length>0;if(retained&&input.selection)throw new StoreError('Release retained references before replacement',409);
      const record:BuildInstance={id,packageId:previous?.packageId??input.selection!.packageId,version:input.selection?.version??previous?.version,installationId:previous?.installationId??randomUUID(),revision:(previous?.revision??0)+1,
        desired:input.selection,retired:false,observed:retained?'draining':restart?'restart_required':'queued',blockers:[],operationId:input.operationId};
      // An instance cannot silently change its package/data namespace.
      if(previous&&input.selection&&previous.packageId!==input.selection.packageId)throw new StoreError('Choose a new instance for another package',409);
      this.control.saveBuild(record);
    });
    if(applied&&!restart&&this.control.build(id)!.observed!=='draining'){
      const before=this.applying.get(id)??Promise.resolve();
      const task=before.catch(()=>{}).then(()=>this.applyBuild(id,input.operationId));this.applying.set(id,task);
      try{await task;}finally{if(this.applying.get(id)===task)this.applying.delete(id);}
    }else if(!applied)await this.applying.get(id);
    return this.buildView(id);
  }
  /** Trusted next-start assembly calls this once. Online restart-only commands
   * never invoke it, and receipt replay never retries a failed factory. */
  async startBuilds(){
    if(this.restored)throw new StoreError('Build startup selection is already consumed',409);
    this.restored=true;
    for(const record of this.control.builds())if(!record.retired){
      if(record.kind==='package')continue;
      if(record.kind==='instance'){
        if(!record.desired){if(record.observed==='restart_required'){record.observed='stopped';record.blockers=[];this.control.saveBuild(record);}continue;}
        // Worker package instances resume their persisted desired selection
        // without a second lazy installation path.
        const ready=record.instance?.view.capabilities.every(capability=>capability.state!=='unknown')&&record.instance.view.capabilities.some(capability=>capability.state==='verified');
        record.observed=ready?'active':'blocked';record.blockers=ready?[]:['capability_unverified'];this.control.saveBuild(record);continue;
      }
      if(!record.desired){if(record.observed==='restart_required'){record.observed='stopped';record.blockers=[];this.control.saveBuild(record);}continue;}
      // Interrupted/failed activation needs an explicit new command. Boot must
      // not turn the persisted acknowledgement into an automatic retry.
      if(['starting','queued','blocked','draining'].includes(record.observed))continue;
      const task=this.applyBuild(record.id,record.operationId);this.applying.set(record.id,task);
      try{await task;}finally{if(this.applying.get(record.id)===task)this.applying.delete(record.id);}
    }
  }
  private async applyBuild(id:string,operationId:string){
    let record=this.control.build(id)!;
    if(record.operationId!==operationId||!this.accepting)return;
    const current=this.buildHandles.get(id);
    try{
      // A replacement installs its activation next to the running one; only a
      // completed candidate is registered active and retires the prior handle.
      if(!record.desired){
        this.buildHandles.delete(id);
        await current?.handle.close('disabled');
        record=this.control.build(id)!;if(record.operationId!==operationId||!this.accepting)return;
        record.observed='stopped';this.control.saveBuild(record);return;
      }
      const selection=record.desired,build=this.builds.get(selection.packageId+'@'+selection.version);
      if(!build)throw new StoreError('Build dependency is unavailable',409);
      record.observed='starting';this.control.saveBuild(record);
      const host=this.hostOwner!.host,identity:ScopeIdentity={host:host.identity,packageId:selection.packageId,installationId:record.installationId,instanceId:id,activationId:randomUUID()};
      // Every dependency has an exact executable pin; descriptor/catalog
      // membership alone cannot satisfy a requirement or choose a provider.
      for(const dependency of build.contribution.requires??[]){
        if(dependency.required===false)continue;
        const pinned=(build.requires??[]).some(pin=>{
          if(dependency.kind==='service')return pin.service.id===dependency.id&&pin.service.apiVersion===dependency.version;
          if(dependency.kind==='host')return this.hostOwner!.hostDependencies?.some(fact=>fact.id===dependency.id&&fact.version===dependency.version&&sameBinding(fact.binding,pin));
          return [...this.buildHandles.values()].some(owned=>{
            if(owned===current||!sameScope(owned.handle.identity,pin.provider.scope))return false;
            const provider=this.builds.get(owned.selection.packageId+'@'+owned.selection.version);
            return dependency.kind==='package'?owned.selection.packageId===dependency.id&&owned.selection.version===dependency.version:
              provider?.contribution.id===dependency.id&&provider.contribution.version===dependency.version;
          });
        });
        if(!pinned)throw new PluginHostError('dependency_unavailable');
      }
      const apiVersion=build.contribution.provides?.[0]?.apiVersion??'1';
      const handle=await host.install({identity,contributions:[{id:build.contribution.id,apiVersion}],requires:[this.hostOwner!.binding(),...(build.requires??[])],optional:build.optional,
        restartRequired:build.replacement==='restart',factory:async context=>{
          const published=new Set<string>();
          const lifecycle=await build.factory(Object.freeze({...context,provide:<T>(id:string,contract:import('@mote/plugin-api/contracts').ServiceContract<T>,value:T,revision=0)=>{
            if(id!==build.contribution.id||!build.contribution.provides?.some(port=>port.id===contract.id&&port.apiVersion===contract.apiVersion))throw new PluginHostError('invalid_contract');
            const binding=context.provide(id,contract,value,revision);published.add(contract.id);return binding;
          }}),selection.configurationRevision);
          // Adopt before cancellation/publication checks, preserving the H04
          // cleanup contract and every original lifecycle receiver.
          return {prepare:()=>lifecycle.prepare(),start:async()=>{await lifecycle.start();if(build.contribution.provides?.some(port=>!published.has(port.id)))throw new PluginHostError('dependency_unavailable');},
            quiesce:reason=>lifecycle.quiesce(reason),stop:reason=>lifecycle.stop(reason),dispose:()=>lifecycle.dispose()};
        }});
      const latest=this.control.build(id)!;
      if(!this.accepting||latest.operationId!==operationId){await handle.close('revoked');return;}
      this.buildHandles.set(id,{handle,selection});latest.observed='active';latest.blockers=[];this.control.saveBuild(latest);
      await current?.handle.close('upgrade');
    }catch(error){
      const latest=this.control.build(id)!;if(latest.operationId!==operationId)return;
      // A failed candidate never kills the surviving activation; its reason is
      // a blocker on the desired selection, not a loss of the observed one.
      const surviving=this.buildHandles.get(id);
      latest.observed=surviving&&!surviving.handle.signal.aborted?'active':'blocked';
      latest.blockers=[error instanceof PluginHostError?error.code:'activation_requires_attention'];this.control.saveBuild(latest);
    }
  }
  async retireBuild(id:string,raw:unknown){
    const input=memoryControlCommandSchema.parse(raw),prior=this.control.build(id) as StoredBuild|undefined;
    if(prior?.kind==='package'||prior?.kind==='instance'){
      const packageId=prior.packageId,command=input.expectedRevision!==prior.revision&&input.expectedRevision===this.revision()?{...input,expectedRevision:prior.revision}:input;
      this.command('retire-build:'+id,command,()=>this.control.build(id)?.revision??prior.revision,()=>{
        const records=this.buildRecords(),record=records.find(value=>value.id===id);if(!record||record.retired)throw new StoreError('Build instance not found',404);
        const scoped=records.filter(value=>!value.retired&&(value.id===record.id||record.kind==='package'&&value.kind==='instance'&&value.packageId===packageId));
        if(scoped.some(value=>value.desired||value.kind==='instance'&&this.references(value.id).length)||this.buildHandles.has(id))throw new StoreError('Disable and release references before uninstalling',409);
        for(const value of scoped)this.saveBuild({...value,retired:true,activeSelection:null,revision:value.revision+1});
      });
      return this.buildView(id);
    }
    this.command('retire-build:'+id,input,()=>this.control.build(id)?.revision??0,()=>{
      const record=this.control.build(id);if(!record||record.desired||this.buildHandles.has(id)||this.references(id).length)throw new StoreError('Disable and release references before uninstalling',409);
      record.retired=true;record.revision++;this.control.saveBuild(record);
      // Data deletion is a separate domain command. Installation identity stays.
    });return this.buildView(id);
  }
  quiesce(){this.accepting=false;}
  close(){if(this.closing)return this.closing;this.closed=true;this.quiesce();
    // Removing handlers aborts local calls before resources are released. Never
    // interpret this as rollback of an already submitted provider mutation.
    const tasks=[...this.disposeHandlers.map(dispose=>dispose()),...[...this.runtimes.values()].map(runtime=>runtime.close())];
    for(const owned of this.buildHandles.values())tasks.push(owned.handle.close('shutdown'));
    return this.closing=Promise.allSettled([...tasks,...this.applying.values()]).then(results=>{
      this.runtimes.clear();this.buildHandles.clear();const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      if(errors.length)throw new AggregateError(errors,'Plugin control disposal failed');
    });
  }

}

/** Compiled distribution fact with the successful activation's exact lease
 * binding, never a configuration claim or a not-yet-loaded provider. H04 still
 * validates the binding's actual availability at each installation. */
export interface TrustedHostDependency {readonly id:string;readonly version:string;readonly binding:ServiceBinding}
export interface TrustedPluginBuild {
  readonly packageId:string;readonly version:string;readonly replacement:'hot'|'restart';
  readonly contribution:ManifestContribution;readonly requires?:readonly ServiceBinding[];readonly optional?:readonly ServiceBinding[];
  readonly factory:(context:HostPluginContext,configurationRevision:number)=>PluginLifecycle|Promise<PluginLifecycle>;
}
export const pluginControlDeclaration=Object.freeze({id:'mote.plugin-control',apiVersion:'1'});
export const pluginControlContribution:ManifestContribution=Object.freeze<ManifestContribution>({id:pluginControlDeclaration.id,version:'1.0.0',surface:'data',runtime:'host',provides:[{kind:'service',id:centralServices.pluginControlRead.id,apiVersion:'1',cardinality:'single'}]});
/** Borrowed host/store/executor/release resolver. Only the read port is published;
 * commands and the executable build registry stay in trusted assembly (C08). */
export function createPluginControlPlatform(deps:{store:Store;executor:ExecutionEngine;releases:GitHubPluginReleases;host:PluginHost;hostDependencies?:readonly TrustedHostDependency[]},builds:readonly TrustedPluginBuild[]=[]){
  let center:PluginCenter|undefined,binding:ServiceBinding|undefined,claimed=false;
  const current=()=>{if(!center)throw new StoreError('Plugin control is unavailable',503);return center;};
  return Object.freeze({
    factory:(context:HostPluginContext):PluginLifecycle=>{
      if(claimed||context.scope.identity.host.id!==deps.host.identity.id||context.scope.identity.host.kind!==deps.host.identity.kind)throw new StoreError('Plugin control factory is already owned or belongs to another host',409);claimed=true;
      return {
      prepare(){center=new PluginCenter(deps.store,deps.executor,deps.releases,{host:deps.host,assertCurrent:context.scope.assertCurrent,hostDependencies:structuredClone(deps.hostDependencies??[]),binding:()=>{if(!binding)throw new StoreError('Control binding unavailable',503);return binding;}});context.scope.defer(()=>center!.close());for(const build of builds)center.registerBuild(build);},
      start(){binding=context.provide(pluginControlDeclaration.id,centralServices.pluginControlRead,{view:()=>current().view(),instanceView:id=>current().instanceView(id)});},
      quiesce(){current().quiesce();},stop(){return current().close();},dispose(){return center?.close();},
    };},
    get assembly(){return current();},
    // The root invokes this after its control handle has become active.
    startBuilds(){return current().startBuilds();},
  });
}
