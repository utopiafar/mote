import {createHash,randomUUID} from 'node:crypto';
import {constants,existsSync,rmSync,renameSync,openSync,fsyncSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {MODEL_FEATURES,type ModelFeature,type ModelSettings} from '@mote/shared/models';
import type {ConfigServiceView,ModelPrice,TokenUsage,UsageReceipt} from '@mote/shared';
import {ConfigService,ConfigServiceError,type ConfigDocument,type ConfigDomainRegistration} from '../config-service.js';
import {registerBuiltinDomains} from '../config.js';
import {privateDirectory,privateFile} from '../private-storage.js';
import {estimateCost,priceSchema,usageTotals} from '../usage-metrics.js';
import {ScopeError,validScopeId} from './baseline.js';
import type {UserContext,UserContextAuthority} from './context.js';
import type {Accounts} from './accounts.js';
import type {DomainLifecycle,LifecycleAuthority,UserDataSubject,UserExport} from './lifecycle.js';
import {ModelResources,userModelFields,removeCredentials,type UserModelConfiguration,type UserModelReference} from './model-resources.js';
import {ModelSnapshots} from './model-snapshots.js';
import {modelSettingsSchema} from '../model-settings.js';

const priceDomain=z.object({items:z.array(priceSchema).max(500).default([])}).strict();
const nonnegative=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokensSchema=z.object({measurement:z.literal('thread_cumulative').optional(),complete:z.boolean().optional(),requests:nonnegative,reportedRequests:nonnegative,inputTokens:nonnegative,outputTokens:nonnegative,totalTokens:nonnegative,cacheReadTokens:nonnegative.optional(),cacheWriteTokens:nonnegative.optional(),reasoningTokens:nonnegative.optional()}).strict();
const usageInput=z.object({status:z.enum(['completed','failed']),durationMs:nonnegative,tokens:tokensSchema.optional()}).strict();
const clone=<T>(v:T):T=>structuredClone(v);
const safeView=(service:ConfigService):ConfigServiceView=>({...service.view(),configFile:'user-config:mote.yaml'});
type State={generation:number;deleted:number;restore_operation:string|null};
type RestoreJournal={operation_id:string;payload_hash:string;generation:number;target_hash:string|null;staging_id:string};
const restoreHash=(value:unknown)=>{
  try{return createHash('sha256').update(JSON.stringify(value,(_key,child)=>child&&typeof child==='object'&&!Array.isArray(child)?Object.fromEntries(Object.keys(child).sort().map(key=>[key,child[key]])):child)).digest('hex');}
  catch{throw new ConfigServiceError('config_invalid');}
};
/** Recovery may adopt only the exact owned, regular file previously staged by
 * this operation. Never follow a substituted link or retain credential bytes. */
function restoreFileHash(path:string):string{
  let handle:number|undefined;
  try{
    handle=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(handle);
    if(!before.isFile()||before.nlink!==1||before.size>1024*1024||(process.getuid&&before.uid!==process.getuid()))throw Error();
    const bytes=readFileSync(handle),after=fstatSync(handle);
    if(bytes.length>1024*1024||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error();
    return createHash('sha256').update(bytes).digest('hex');
  }catch{throw new ConfigServiceError('config_conflict');}
  finally{if(handle!==undefined)closeSync(handle);}
}
type Entry={service:ConfigService;generation:number;accessKey:string;subject:UserDataSubject;initializing:Promise<void>};
export type ModelLease=Readonly<{id:string;snapshotId:string;deploymentId:string;userId:string;operationId:string;feature:ModelFeature;revision:number;instanceRevision:number;reference:Readonly<{kind:'shared'|'personal';id:string}>;provider:string;model:string}>;
type PrivateLease={context:UserContext;generation:number;sharedGeneration?:number;credentialGeneration?:number;credentialRecoveryGeneration?:number;settings:ModelSettings;price?:ModelPrice;configuration:ConfigDocument};
type DurableSnapshot=Omit<PrivateLease,'context'>&{version:1;deploymentId:string;userId:string;authorizationEpoch:number;operationId:string;feature:ModelFeature;revision:number;instanceRevision:number;reference:{kind:'shared'|'personal';id:string};credentialFingerprint?:string};
export type ModelLeaseRestore={status:'restored';lease:ModelLease}|{status:'unavailable';reason:'snapshot_unavailable'|'authorization_changed'|'configuration_deleted'|'credentials_revoked'|'shared_resource_revoked'|'operation_mismatch'};
type CredentialState={profile_id:string;generation:number;recovery_generation:number;present:number;has_credentials:number;fingerprint:string|null;components:string};
const credentialsHash=(settings:ModelSettings)=>restoreHash({apiKey:settings.apiKey,headers:settings.headers,extraBody:settings.extraBody});
function credentialComponents(settings:ModelSettings){
  const paths:string[]=[];
  const visit=(value:unknown,path:string[])=>{if(value&&typeof value==='object'){for(const [key,child] of Object.entries(value))visit(child,[...path,key]);}else if(value!==null&&value!==undefined&&!(typeof value==='string'&&!value.trim()))paths.push(restoreHash(path));};
  visit({apiKey:settings.apiKey,headers:settings.headers,extraBody:settings.extraBody},[]);return paths.sort();
}
export type UserConfigurationService=ReturnType<Configurations['forUser']>;

/** Host-owned per-account ConfigService instances. No request path or userId is
 * accepted by this API. Trusted installed modules register ordinary domains on
 * the same service; the private resolver never expands instance environment. */
export class Configurations {
  readonly resources:ModelResources;
  private readonly snapshots:ModelSnapshots;
  private resourcesUnavailable=false;
  private readonly credentialsUnavailable=new Set<string>();
  private readonly entries=new Map<string,Entry>();
  private readonly opening=new Map<string,Promise<Entry>>();
  private readonly lifecycleQueue=new Map<string,Promise<void>>();
  private readonly leases=new WeakMap<ModelLease,PrivateLease>();
  private readonly domains=new Map<string,(context:UserDataSubject)=>ConfigDomainRegistration>();
  private closed=false;
  private constructor(private readonly options:{directory:string;db:DatabaseSync;authority:UserContextAuthority;accounts?:Accounts;lifecycleAuthority?:LifecycleAuthority},readonly instance:ConfigService){
    options.db.exec(`CREATE TABLE IF NOT EXISTS user_configuration_state(user_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,restore_operation TEXT);
      CREATE TABLE IF NOT EXISTS user_model_usage(user_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS user_configuration_restore_journal(user_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,generation INTEGER NOT NULL,target_hash TEXT,staging_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_resource_generations(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,fingerprint TEXT);
      CREATE TABLE IF NOT EXISTS model_resource_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_model_credential_generations(user_id TEXT NOT NULL,profile_id TEXT NOT NULL,generation INTEGER NOT NULL,recovery_generation INTEGER NOT NULL,present INTEGER NOT NULL,has_credentials INTEGER NOT NULL,fingerprint TEXT,components TEXT NOT NULL,PRIMARY KEY(user_id,profile_id));
      CREATE TABLE IF NOT EXISTS user_model_snapshot_revision(user_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);`);
    this.resources=new ModelResources(instance,{
      load:()=>options.db.prepare('SELECT id,generation,fingerprint FROM model_resource_generations').all().map(r=>({id:String(r.id),generation:Number(r.generation),...(r.fingerprint?{fingerprint:String(r.fingerprint)}:{})})),
      save:(id,state)=>{options.db.prepare('INSERT INTO model_resource_generations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint').run(id,state.generation,state.fingerprint??null);},
    });
    this.snapshots=new ModelSnapshots({directory:options.directory,db:options.db,deploymentId:options.authority.deploymentId});
  }
  static async open(options:Configurations['options']&{instancePath?:string;instanceDocument?:ConfigDocument}){
    const instance=new ConfigService({path:options.instancePath??join(options.directory,'instance.yaml'),initialDocument:options.instanceDocument??{version:1,revision:0}});
    registerBuiltinDomains(instance);
    const service=new Configurations(options,instance);
    try{await instance.initialize();service.syncResources(true);instance.onChange(()=>{try{service.syncResources(false);}catch{service.resourcesUnavailable=true;}});await instance.startWatching();return service;}
    catch(error){await instance.close();throw error;}
  }
  /** Register before the first account is opened. Factories own schema,
   * sensitivity and prepare/publish/rollback; export removes declared secrets. */
  registerDomain(id:string,factory:(context:UserDataSubject)=>ConfigDomainRegistration){
    if(this.entries.size||this.opening.size||this.closed||['models','modelPrices'].includes(id)||this.domains.has(id))throw new ConfigServiceError('config_conflict');
    this.domains.set(id,factory);
  }
  private state(userId:string):State{
    this.options.db.prepare('INSERT OR IGNORE INTO user_configuration_state(user_id) VALUES(?)').run(userId);
    return this.options.db.prepare('SELECT generation,deleted,restore_operation FROM user_configuration_state WHERE user_id=?').get(userId) as State;
  }
  private assertSubject(context:UserDataSubject,purpose?:'export'|'delete'|'restore'){
    if(this.closed||context.deploymentId!==this.options.authority.deploymentId)throw new ScopeError('invalid_identity',401);
    if('credentialId' in context)this.options.authority.assert(context);
    else{this.options.lifecycleAuthority?.assert(context);if(!this.options.lifecycleAuthority||context.domain!=='configuration'||context.purpose!==purpose)throw new ScopeError('invalid_identity',403);}
  }
  private assertGeneration(userId:string,generation:number){const state=this.state(userId);if(this.closed||state.deleted||state.generation!==generation)throw new ScopeError('invalid_identity',401);}
  private accountFence(context:UserDataSubject){
    if('credentialId' in context){if(this.options.accounts)this.options.accounts.assertAccountEnabled(context.userId,context.authorizationEpoch);else this.options.authority.assert(context);}
  }
  private path(userId:string){if(!validScopeId(userId))throw new ScopeError('invalid_identity',401);return join(this.options.directory,'configuration','users',userId);}
  private syncResources(bootstrap:boolean){
    if(this.resourcesUnavailable)throw new ConfigServiceError('config_unavailable');
    const prior=this.options.db.prepare('SELECT revision FROM model_resource_revision WHERE singleton=1').get();
    if(bootstrap&&prior&&Number(prior.revision)!==this.instance.revision)this.resources.invalidateGenerations();
    this.resources.listShared();
    this.options.db.prepare('INSERT INTO model_resource_revision VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision').run(this.instance.revision);
  }
  private assertResources(){if(this.resourcesUnavailable)throw new ConfigServiceError('config_unavailable');}
  private credentialState(userId:string,profileId:string){return this.options.db.prepare('SELECT profile_id,generation,recovery_generation,present,has_credentials,fingerprint,components FROM user_model_credential_generations WHERE user_id=? AND profile_id=?').get(userId,profileId) as CredentialState|undefined;}
  private syncCredentials(userId:string,service:ConfigService,bootstrap:boolean){
    if(this.credentialsUnavailable.has(userId))throw new ConfigServiceError('config_unavailable');
    try{
      const profiles=service.current<UserModelConfiguration>('models').profiles;
      const previous=this.options.db.prepare('SELECT profile_id,generation,recovery_generation,present,has_credentials,fingerprint,components FROM user_model_credential_generations WHERE user_id=?').all(userId) as CredentialState[];
      const revision=this.options.db.prepare('SELECT revision FROM user_model_snapshot_revision WHERE user_id=?').get(userId);
      const uncertain=bootstrap&&revision&&Number(revision.revision)!==service.revision;
      this.options.db.exec('BEGIN IMMEDIATE');try{
        for(const row of previous){
          const profile=profiles.find(p=>p.id===row.profile_id),present=Boolean(profile),components=profile?credentialComponents(profile.settings):[];
          const previousComponents=z.array(z.string()).parse(JSON.parse(row.components));
          const revoke=Boolean(uncertain)||Boolean(row.present&&!present)||previousComponents.some(path=>!components.includes(path));
          const fingerprint=profile?credentialsHash(profile.settings):null,recoveryRevoke=Boolean(uncertain)||row.fingerprint!==fingerprint||Boolean(row.present&&!present);
          this.options.db.prepare('UPDATE user_model_credential_generations SET generation=?,recovery_generation=?,present=?,has_credentials=?,fingerprint=?,components=? WHERE user_id=? AND profile_id=?').run(row.generation+Number(revoke),row.recovery_generation+Number(recoveryRevoke),Number(present),Number(components.length>0),fingerprint,JSON.stringify(components),userId,row.profile_id);
        }
        for(const profile of profiles)if(!previous.some(p=>p.profile_id===profile.id)){const components=credentialComponents(profile.settings);this.options.db.prepare('INSERT INTO user_model_credential_generations VALUES(?,?,1,1,1,?,?,?)').run(userId,profile.id,Number(components.length>0),credentialsHash(profile.settings),JSON.stringify(components));}
        this.options.db.prepare('INSERT INTO user_model_snapshot_revision VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision').run(userId,service.revision);this.options.db.exec('COMMIT');
      }catch(error){this.options.db.exec('ROLLBACK');throw error;}
    }catch(error){if(error instanceof ScopeError)throw error;this.credentialsUnavailable.add(userId);throw new ConfigServiceError('config_unavailable');}
  }
  private async entry(context:UserDataSubject):Promise<Entry>{
    this.assertSubject(context,'export');const state=this.state(context.userId);this.assertGeneration(context.userId,state.generation);
    const accessKey='credentialId' in context?'account:'+context.authorizationEpoch:'lifecycle:'+context.operationId;
    const prior=this.entries.get(context.userId);if(prior){
      try{await prior.initializing;}catch(error){if(prior.accessKey===accessKey)throw error;return this.entry(context);}
      this.assertSubject(context,'export');
      if(this.entries.get(context.userId)!==prior)return this.entry(context);
      // Domain handlers retain their admission subject. A fresh session must
      // not reuse handlers bound to a credential that has since logged out,
      // nor mutate that subject and revive an older suspended request.
      let priorCurrent=true;try{this.assertSubject(prior.subject,'export');}catch(error){if(!(error instanceof ScopeError))throw error;priorCurrent=false;}
      if(priorCurrent&&prior.accessKey===accessKey&&('credentialId' in context||prior.subject===context)){this.assertGeneration(context.userId,prior.generation);return prior;}
      // Keep the retiring entry visible while its transaction queue drains.
      // A concurrent new epoch must wait for rollback before reading the YAML.
      await prior.service.close();if(this.entries.get(context.userId)===prior)this.entries.delete(context.userId);return this.entry(context);
    }
    const pending=this.opening.get(context.userId);if(pending){await pending.catch(()=>{});return this.entry(context);}
    const create=async()=>{
      this.assertGeneration(context.userId,state.generation);this.accountFence(context);
      for(const path of [join(this.options.directory,'configuration'),join(this.options.directory,'configuration','users'),this.path(context.userId)])privateDirectory(path);
      const path=join(this.path(context.userId),'mote.yaml');privateFile(path);
      const lifecycle=!('credentialId' in context);
      const guard=()=>{this.assertGeneration(context.userId,state.generation);if(lifecycle)this.assertSubject(context,'export');else this.accountFence(context);};
      const service=new ConfigService({path,initialDocument:{version:1,revision:0},assertAccess:guard});
      service.register({id:'models',schema:this.resources.schema(),defaultValue:{profiles:[],selections:{}},fields:userModelFields,resolve:raw=>raw});
      service.register({id:'modelPrices',schema:priceDomain,defaultValue:{items:[]},resolve:raw=>raw});
      for(const [id,factory] of this.domains){const domain=factory(context);if(domain.id!==id||!domain.resolve)throw new ConfigServiceError('config_invalid');service.register(lifecycle?{...domain,prepare:undefined}:domain);}
      const entry:Entry={service,generation:state.generation,accessKey,subject:context,initializing:Promise.resolve()};
      if(!lifecycle)service.onChange(()=>{try{this.syncCredentials(context.userId,service,false);}catch{/* Snapshot admission remains closed until a clean restart. */}});
      entry.initializing=(async()=>{await service.initialize();if(!lifecycle){this.syncCredentials(context.userId,service,true);await service.startWatching();}guard();})();
      this.entries.set(context.userId,entry);
      try{await entry.initializing;return entry;}catch(error){if(this.entries.get(context.userId)===entry)this.entries.delete(context.userId);await service.close();throw error;}
    };
    const result=create();this.opening.set(context.userId,result);
    try{return await result;}finally{if(this.opening.get(context.userId)===result)this.opening.delete(context.userId);}
  }
  forUser(context:UserContext){
    this.options.authority.assert(context);
    const current=()=>this.options.authority.assert(context);
    return Object.freeze({
      view:async()=>{current();const {service}=await this.entry(context);current();return safeView(service);},
      update:async(patches:Record<string,unknown>,revision:number)=>{current();const {service}=await this.entry(context);await service.updateMany(patches,revision,false,current);current();return safeView(service);},
      replace:async(domain:string,value:unknown,revision:number,preserveRedactedSecrets=false)=>{current();const {service}=await this.entry(context);await (preserveRedactedSecrets?service.replaceView(domain,value,revision,current):service.replace(domain,value,revision,current));current();return safeView(service);},
      replaceViews:async(values:Record<string,unknown>,revision:number)=>{current();const {service}=await this.entry(context);await service.updateMany(values,revision,true,current,true);current();return safeView(service);},
      reload:async()=>{current();const {service}=await this.entry(context);await service.reload(current);current();return safeView(service);},
      models:async()=>{current();const {service}=await this.entry(context);current();this.assertResources();return {shared:this.resources.listShared(),personal:(safeView(service).domains.find(d=>d.id==='models')!.effective as UserModelConfiguration).profiles,selections:service.current<UserModelConfiguration>('models').selections};},
      lease:(feature:ModelFeature,operationId:string)=>this.lease(context,feature,operationId),
      restoreLease:(snapshotId:string,operationId:string)=>this.restoreLease(context,snapshotId,operationId),
      selection:async(feature:ModelFeature)=>{current();const {service}=await this.entry(context);current();this.assertResources();const {reference,settings}=this.resources.resolve(service.current('models'),feature);return {reference,provider:settings.provider,model:settings.model,revision:service.revision,instanceRevision:this.instance.revision};},
      usage:()=>{current();this.assertGeneration(context.userId,this.state(context.userId).generation);return this.usage(context.userId);},
    });
  }
  private usage(userId:string){
    const items=(this.options.db.prepare('SELECT json FROM user_model_usage WHERE user_id=? ORDER BY id').all(userId) as {json:string}[]).map(r=>JSON.parse(r.json) as UsageReceipt);
    return {items,total:usageTotals(items)};
  }
  async lease(context:UserContext,feature:ModelFeature,operationId:string):Promise<ModelLease>{return this.leaseReference(context,feature,operationId);}
  /** Trusted domain recipes may pin an installed scoped model reference without
   * changing the user's feature selection. Resolve the whole fixed connection;
   * a reference never combines its key with a caller endpoint or settings. */
  async leaseReference(context:UserContext,feature:ModelFeature,operationId:string,selected?:UserModelReference,modelOverride?:string):Promise<ModelLease>{
    this.options.authority.assert(context);if(!MODEL_FEATURES.includes(feature)||!validScopeId(operationId))throw new ConfigServiceError('config_invalid');
    const entry=await this.entry(context);this.options.authority.assert(context);
    this.assertResources();if(this.credentialsUnavailable.has(context.userId))throw new ConfigServiceError('config_unavailable');
    const models=entry.service.current<UserModelConfiguration>('models');
    const explicit=selected?z.object({kind:z.enum(['personal','shared']),id:z.string().min(1).max(256)}).strict().parse(selected):undefined;
    const resolved=this.resources.resolve(explicit?{...models,selections:{...models.selections,[feature]:explicit}}:models,feature),reference=resolved.reference;
    // A personal connection may select a model ID for this request. A shared
    // resource remains the administrator's complete fixed connection.
    const override=modelOverride===undefined?undefined:z.string().trim().min(1).max(512).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)).parse(modelOverride);
    if(reference.kind==='shared'&&override!==undefined&&override!==resolved.settings.model)throw new ConfigServiceError('config_invalid');
    const settings=override===undefined?resolved.settings:modelSettingsSchema.parse({...resolved.settings,model:override});
    const prices=entry.service.current<z.infer<typeof priceDomain>>('modelPrices').items;
    const credential=reference.kind==='personal'?this.credentialState(context.userId,reference.id):undefined;
    const snapshot:DurableSnapshot={version:1,deploymentId:context.deploymentId,userId:context.userId,authorizationEpoch:context.authorizationEpoch,operationId,feature,revision:entry.service.revision,instanceRevision:this.instance.revision,reference,generation:entry.generation,...(reference.kind==='shared'?{sharedGeneration:this.resources.generation(reference.id)}:{credentialGeneration:credential?.generation,credentialRecoveryGeneration:credential?.recovery_generation,credentialFingerprint:credentialsHash(settings)}),settings:clone(settings),price:clone(prices.find(p=>p.provider===settings.provider&&p.model===settings.model)),configuration:entry.service.effectiveDocument()};
    const id=this.snapshots.save(context.userId,snapshot);
    const lease=Object.freeze({id,snapshotId:id,deploymentId:context.deploymentId,userId:context.userId,operationId,feature,revision:snapshot.revision,instanceRevision:snapshot.instanceRevision,reference:Object.freeze(reference),provider:settings.provider,model:settings.model});
    this.leases.set(lease,{context,generation:snapshot.generation,sharedGeneration:snapshot.sharedGeneration,credentialGeneration:snapshot.credentialGeneration,settings:snapshot.settings,price:snapshot.price,configuration:snapshot.configuration});
    return lease;
  }
  /** Only a freshly host-verified user/task context can restore a stored
   * capability. Public receipts and caller-selected settings are never inputs. */
  async restoreLease(context:UserContext,snapshotId:string,expectedOperationId:string):Promise<ModelLeaseRestore>{
    this.options.authority.assert(context);
    const unavailable=(reason:Extract<ModelLeaseRestore,{status:'unavailable'}>['reason']):ModelLeaseRestore=>({status:'unavailable',reason});
    if(!z.string().uuid().safeParse(snapshotId).success||!validScopeId(expectedOperationId))return unavailable('snapshot_unavailable');
    let raw:unknown;try{raw=this.snapshots.read(context.userId,snapshotId);}catch{return unavailable('snapshot_unavailable');}
    if(!raw)return unavailable('snapshot_unavailable');
    const parsed=z.object({version:z.literal(1),deploymentId:z.string(),userId:z.string(),authorizationEpoch:nonnegative,operationId:z.string(),feature:z.enum(MODEL_FEATURES),revision:nonnegative,instanceRevision:nonnegative,reference:z.object({kind:z.enum(['shared','personal']),id:z.string()}).strict(),generation:nonnegative,sharedGeneration:nonnegative.optional(),credentialGeneration:nonnegative.optional(),credentialRecoveryGeneration:nonnegative.optional(),credentialFingerprint:z.string().optional(),settings:modelSettingsSchema,price:priceSchema.optional(),configuration:z.record(z.unknown())}).strict().safeParse(raw);
    if(!parsed.success)return unavailable('snapshot_unavailable');const snapshot=parsed.data;
    if(snapshot.deploymentId!==context.deploymentId||snapshot.userId!==context.userId)return unavailable('snapshot_unavailable');
    if(snapshot.operationId!==expectedOperationId)return unavailable('operation_mismatch');
    if(snapshot.authorizationEpoch!==context.authorizationEpoch)return unavailable('authorization_changed');
    const state=this.state(context.userId);if(state.deleted||state.generation!==snapshot.generation)return unavailable('configuration_deleted');
    this.accountFence(context);
    let entry:Entry;try{entry=await this.entry(context);}catch(error){this.options.authority.assert(context);return unavailable('snapshot_unavailable');}
    this.options.authority.assert(context);try{this.assertResources();}catch{return unavailable('snapshot_unavailable');}
    if(snapshot.reference.kind==='shared'){
      try{if(snapshot.sharedGeneration!==this.resources.generation(snapshot.reference.id))return unavailable('shared_resource_revoked');const current=this.resources.resolve({profiles:[],selections:{[snapshot.feature]:snapshot.reference}},snapshot.feature);if(restoreHash(current.settings)!==restoreHash(snapshot.settings))return unavailable('shared_resource_revoked');}catch{return unavailable('shared_resource_revoked');}
    }else{
      const credential=this.credentialState(context.userId,snapshot.reference.id);
      if(this.credentialsUnavailable.has(context.userId)||!credential?.present||credential.generation!==snapshot.credentialGeneration||credential.recovery_generation!==snapshot.credentialRecoveryGeneration||credential.fingerprint!==snapshot.credentialFingerprint)return unavailable('credentials_revoked');
    }
    const id=snapshotId,lease=Object.freeze({id,snapshotId:id,deploymentId:context.deploymentId,userId:context.userId,operationId:snapshot.operationId,feature:snapshot.feature,revision:snapshot.revision,instanceRevision:snapshot.instanceRevision,reference:Object.freeze(snapshot.reference),provider:snapshot.settings.provider,model:snapshot.settings.model});
    this.leases.set(lease,{context,generation:snapshot.generation,sharedGeneration:snapshot.sharedGeneration,credentialGeneration:snapshot.credentialGeneration,settings:clone(snapshot.settings),price:clone(snapshot.price),configuration:clone(snapshot.configuration) as ConfigDocument});
    this.assertLease(lease);return {status:'restored',lease};
  }
  /** A domain operation inherits a retained immutable model connection and
   * configuration while receiving its own durable usage identity. No current
   * selection or caller-supplied endpoint/key is consulted as a replacement. */
  async forkLease(context:UserContext,snapshotId:string,expectedOperationId:string,operationId:string):Promise<ModelLease>{
    this.options.authority.assert(context);if(!validScopeId(operationId))throw new ConfigServiceError('config_invalid');
    const restored=await this.restoreLease(context,snapshotId,expectedOperationId);this.options.authority.assert(context);
    if(restored.status!=='restored')throw new ConfigServiceError('config_unavailable');
    const value=this.assertLease(restored.lease),source=this.snapshots.read(context.userId,snapshotId) as DurableSnapshot;
    if(!source||source.operationId!==expectedOperationId)throw new ConfigServiceError('config_unavailable');
    const id=this.snapshots.save(context.userId,{...source,operationId}),lease=Object.freeze({...restored.lease,id,snapshotId:id,operationId});
    this.leases.set(lease,{...value,context});this.assertLease(lease);return lease;
  }
  /** M05/M06/M07 hold a genuine lease, not a deserialized receipt. Logout does
   * not cancel admitted work; disable/reset/delete fences all late publications.
   * Shared catalog removal or a changed resource also revokes its leased access. */
  assertLease(lease:ModelLease){
    const privateLease=this.leases.get(lease);if(!privateLease)throw new ScopeError('invalid_identity',401);
    this.assertGeneration(lease.userId,privateLease.generation);this.accountFence(privateLease.context);
    this.assertResources();if(this.credentialsUnavailable.has(lease.userId))throw new ConfigServiceError('config_unavailable');
    if(lease.reference.kind==='shared'){
      if(privateLease.sharedGeneration!==this.resources.generation(lease.reference.id))throw new ScopeError('invalid_identity',401);
      const actual=this.resources.resolve({profiles:[],selections:{[lease.feature]:lease.reference}},lease.feature);
      if(JSON.stringify(actual.settings)!==JSON.stringify(privateLease.settings))throw new ScopeError('invalid_identity',401);
    }
    else{const credential=this.credentialState(lease.userId,lease.reference.id);if(!credential?.present||credential.generation!==privateLease.credentialGeneration)throw new ScopeError('invalid_identity',401);}
    return privateLease;
  }
  /** Only trusted runtime adapters receive credentials. A model tool or HTTP
   * request cannot select the user, replace a lease, or alter shared transport. */
  async withModel<T>(lease:ModelLease,work:(settings:Readonly<ModelSettings>,configuration:Readonly<ConfigDocument>)=>Promise<T>):Promise<T>{
    const value=this.assertLease(lease);let result:T;
    try{result=await work(clone(value.settings),clone(value.configuration));}
    catch{this.assertLease(lease);throw new ConfigServiceError('config_unavailable');}
    this.assertLease(lease);return result;
  }
  recordUsage(lease:ModelLease,input:{status:'completed'|'failed';durationMs:number;tokens?:TokenUsage}){
    const value=this.assertLease(lease),usage=usageInput.parse(input);
    const receipt:UsageReceipt={id:lease.id,provider:lease.provider,model:lease.model,operation:lease.feature,attribution:{operationId:lease.operationId,agentId:'__unknown__',moduleId:'__unknown__',skillId:null},createdAt:new Date().toISOString(),...usage,estimatedCost:estimateCost(usage.tokens,value.price),currency:value.price?.currency??'USD',...(value.price?{price:value.price}:{})};
    const old=this.options.db.prepare('SELECT json FROM user_model_usage WHERE user_id=? AND id=?').get(lease.userId,lease.id);
    if(old)return JSON.parse(String(old.json)) as UsageReceipt;
    this.options.db.prepare('INSERT INTO user_model_usage VALUES(?,?,?)').run(lease.userId,lease.id,JSON.stringify(receipt));return clone(receipt);
  }
  private async forget(userId:string){const pending=this.opening.get(userId);if(pending)await pending.catch(()=>{});const old=this.entries.get(userId);this.entries.delete(userId);if(old)await old.service.close();}
  private async serializeLifecycle<T>(userId:string,work:()=>Promise<T>):Promise<T>{
    const previous=this.lifecycleQueue.get(userId)??Promise.resolve();
    const result=previous.then(work),tail=result.then(()=>{},()=>{});this.lifecycleQueue.set(userId,tail);
    try{return await result;}finally{if(this.lifecycleQueue.get(userId)===tail)this.lifecycleQueue.delete(userId);}
  }
  readonly lifecycle:DomainLifecycle={
  // Personal archive import preserves live settings and operational authority.
  importUser:false,
    exportUser:async context=>{
      this.assertSubject(context,'export');const entry=await this.entry(context);this.assertSubject(context,'export');
      try{
      const document=entry.service.document();document.models=removeCredentials(entry.service.current('models'));
      // Registered extension projections already replace declared sensitive
      // fields with booleans. They are omitted on portable export and must be
      // re-entered by their owning domain rather than restored as credentials.
      for(const domain of entry.service.view().domains)if(!['models','modelPrices'].includes(domain.id)){
        if(domain.fields.some(f=>f.sensitive))delete document[domain.id];
      }
      return {domain:'configuration',version:1,deploymentId:context.deploymentId,userId:context.userId,payload:{document,usage:this.usage(context.userId).items,credentialsIncluded:false,omittedDomains:entry.service.view().domains.filter(d=>!Object.hasOwn(document,d.id)).map(d=>d.id)}};
      }finally{if(!('credentialId' in context)){if(this.entries.get(context.userId)===entry)this.entries.delete(context.userId);await entry.service.close();}}
    },
    deleteUser:async(context,operationId)=>this.serializeLifecycle(context.userId,async()=>{
      this.assertSubject(context,'delete');if(!validScopeId(operationId))throw new ConfigServiceError('config_invalid');
      this.options.db.exec('BEGIN IMMEDIATE');try{
        this.options.db.prepare('INSERT INTO user_configuration_state(user_id,generation,deleted) VALUES(?,1,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+CASE WHEN deleted=0 THEN 1 ELSE 0 END,deleted=1,restore_operation=NULL').run(context.userId);
        this.options.db.prepare('DELETE FROM user_configuration_restore_journal WHERE user_id=?').run(context.userId);
        this.snapshots.deleteUser(context.userId);
        this.options.db.prepare('DELETE FROM user_model_credential_generations WHERE user_id=?').run(context.userId);
        this.options.db.prepare('DELETE FROM user_model_snapshot_revision WHERE user_id=?').run(context.userId);this.options.db.exec('COMMIT');
      }catch(error){this.options.db.exec('ROLLBACK');throw error;}
      await this.forget(context.userId);this.assertSubject(context,'delete');this.credentialsUnavailable.delete(context.userId);
      rmSync(this.path(context.userId),{recursive:true,force:true});this.options.db.prepare('DELETE FROM user_model_usage WHERE user_id=?').run(context.userId);
      return {status:'complete' as const,operationId};
    }),
    restoreUser:async(context,archive,operationId)=>this.serializeLifecycle(context.userId,async()=>{
      this.assertSubject(context,'restore');
      if(!validScopeId(operationId)||archive.domain!=='configuration'||archive.version!==1||archive.deploymentId!==context.deploymentId||archive.userId!==context.userId)throw new ConfigServiceError('config_invalid');
      const payload=z.object({document:z.object({version:z.literal(1),revision:nonnegative,models:this.resources.schema(),modelPrices:priceDomain}).passthrough(),usage:z.array(z.unknown()).max(100000),credentialsIncluded:z.literal(false),omittedDomains:z.array(z.string())}).strict().parse(archive.payload);
      const restoreDomains:ConfigDomainRegistration[]=[];
      const omitted=new Set(payload.omittedDomains);
      if(omitted.size!==payload.omittedDomains.length||[...omitted].some(id=>!this.domains.has(id)))throw new ConfigServiceError('config_invalid');
      for(const [id,factory] of this.domains){
        if(Object.hasOwn(payload.document,id)){if(omitted.has(id))throw new ConfigServiceError('config_invalid');continue;}
        const domain=factory(context);
        // The owning extension restores its credential-free definition through
        // its own lifecycle grant. M04 restores only the registered empty/default
        // configuration here; omitted YAML never becomes active authorization.
        if(!omitted.has(id)||domain.id!==id||!domain.resolve||!domain.fields?.some(f=>f.sensitive))throw new ConfigServiceError('config_invalid');
        domain.schema.parse(domain.resolve(domain.defaultValue,payload.document));
        payload.document[id]=clone(domain.defaultValue);restoreDomains.push({...domain,prepare:undefined});
      }
      for(const key of Object.keys(payload.document))if(!['version','revision','models','modelPrices'].includes(key)&&!omitted.has(key)){
        const factory=this.domains.get(key);if(!factory)throw new ConfigServiceError('config_invalid');
        const domain=factory(context);if(domain.id!==key||!domain.resolve||domain.fields?.some(f=>f.sensitive))throw new ConfigServiceError('config_invalid');
        domain.schema.parse(domain.resolve(payload.document[key],payload.document));restoreDomains.push({...domain,prepare:undefined});
      }
      if(JSON.stringify(payload.document.models)!==JSON.stringify(removeCredentials(payload.document.models)))throw new ConfigServiceError('config_invalid');
      // Portable user exports are not historical single-account backups. Until
      // M16's whole-instance coordinator supplies a mapped target, restoring
      // usage accepts only this module's validated credential-free receipts.
      const receipts=payload.usage.map(item=>z.object({id:z.string().uuid(),provider:z.string().max(128),model:z.string().max(512),operation:z.enum(MODEL_FEATURES),attribution:z.object({operationId:z.string().refine(validScopeId),agentId:z.literal('__unknown__'),moduleId:z.literal('__unknown__'),skillId:z.null()}).strict(),createdAt:z.string().datetime(),durationMs:nonnegative,status:z.enum(['completed','failed']),tokens:tokensSchema.optional(),estimatedCost:z.number().finite().nonnegative().nullable(),currency:z.enum(['USD','CNY']),price:priceSchema.optional()}).strict().parse(item));
      if(new Set(receipts.map(r=>r.id)).size!==receipts.length)throw new ConfigServiceError('config_invalid');
      const payloadHash=restoreHash({domain:archive.domain,version:archive.version,deploymentId:archive.deploymentId,userId:archive.userId,payload:{...payload,usage:receipts}});
      const readJournal=()=>this.options.db.prepare('SELECT operation_id,payload_hash,generation,target_hash,staging_id FROM user_configuration_restore_journal WHERE user_id=?').get(context.userId) as RestoreJournal|undefined;
      const state=this.state(context.userId),targetPath=join(this.path(context.userId),'mote.yaml');
      let journal=readJournal();
      const matches=(value:RestoreJournal|undefined)=>value?.operation_id===operationId&&value.payload_hash===payloadHash;
      if(state.restore_operation===operationId){if(!matches(journal))throw new ConfigServiceError('config_conflict');return;}
      // A completed rename can outlive a rolled-back activation transaction.
      // Only the same pending operation and exact file hash may recover it.
      if(journal){
        if(!matches(journal)||state.deleted!==1||state.generation!==journal.generation||state.restore_operation!==null)throw new ConfigServiceError('config_conflict');
      }else{
        if(existsSync(targetPath)||!state.deleted&&(this.entries.has(context.userId)||this.usage(context.userId).items.length))throw new ConfigServiceError('config_conflict');
        this.options.db.exec('BEGIN IMMEDIATE');try{
          this.assertSubject(context,'restore');
          this.options.db.prepare('UPDATE user_configuration_state SET generation=generation+1,deleted=1,restore_operation=NULL WHERE user_id=?').run(context.userId);
          journal={operation_id:operationId,payload_hash:payloadHash,generation:this.state(context.userId).generation,target_hash:null,staging_id:randomUUID()};
          this.options.db.prepare('INSERT INTO user_configuration_restore_journal VALUES(?,?,?,?,?,?)').run(context.userId,journal.operation_id,journal.payload_hash,journal.generation,journal.target_hash,journal.staging_id);this.options.db.exec('COMMIT');
        }catch(error){this.options.db.exec('ROLLBACK');throw error;}
      }
      const pending=journal;
      if(!pending||!z.string().uuid().safeParse(pending.staging_id).success)throw new ConfigServiceError('config_conflict');
      const staging=join(this.path(context.userId),`.restore-${pending.staging_id}.yaml`);
      let expectedHash=pending.target_hash;
      try{
        await this.forget(context.userId);this.assertSubject(context,'restore');
        for(const path of [join(this.options.directory,'configuration'),join(this.options.directory,'configuration','users'),this.path(context.userId)])privateDirectory(path);
        if(existsSync(targetPath)){
          if(!expectedHash||restoreFileHash(targetPath)!==expectedHash)throw new ConfigServiceError('config_conflict');
        }else{
          // A crashed attempt may leave its own stage. Rebuild from the supplied
          // validated archive rather than trusting any pre-existing stage bytes.
          rmSync(staging,{force:true});
          const target=new ConfigService({path:staging,initialDocument:{...payload.document,revision:0},assertAccess:()=>this.assertSubject(context,'restore')});
          target.register({id:'models',schema:this.resources.schema(),defaultValue:{profiles:[],selections:{}},resolve:raw=>raw,fields:userModelFields});target.register({id:'modelPrices',schema:priceDomain,defaultValue:{items:[]},resolve:raw=>raw});
          for(const domain of restoreDomains)target.register(domain);
          try{await target.initialize();this.assertSubject(context,'restore');}finally{await target.close();}
          expectedHash=restoreFileHash(staging);
          // Persist provenance before the rename. No credential or archive
          // content is copied into the journal, only fixed identifiers/hashes.
          this.options.db.prepare('UPDATE user_configuration_restore_journal SET target_hash=? WHERE user_id=? AND operation_id=? AND payload_hash=? AND generation=?').run(expectedHash,context.userId,operationId,payloadHash,pending.generation);
        }
        this.options.db.exec('BEGIN IMMEDIATE');let published=false;try{
          this.assertSubject(context,'restore');
          const current=this.state(context.userId),record=readJournal();
          if(current.generation!==pending.generation||current.deleted!==1||!matches(record)||record?.generation!==pending.generation||record.target_hash!==expectedHash)throw new ConfigServiceError('config_conflict');
          if(existsSync(targetPath)){if(restoreFileHash(targetPath)!==expectedHash)throw new ConfigServiceError('config_conflict');}
          else{if(restoreFileHash(staging)!==expectedHash)throw new ConfigServiceError('config_conflict');renameSync(staging,targetPath);published=true;}
          const directory=openSync(this.path(context.userId),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
          this.options.db.prepare('DELETE FROM user_model_usage WHERE user_id=?').run(context.userId);
          for(const receipt of receipts)this.options.db.prepare('INSERT INTO user_model_usage VALUES(?,?,?)').run(context.userId,receipt.id,JSON.stringify(receipt));
          this.options.db.prepare('UPDATE user_configuration_state SET generation=generation+1,deleted=0,restore_operation=? WHERE user_id=?').run(operationId,context.userId);this.options.db.exec('COMMIT');
        }catch(error){this.options.db.exec('ROLLBACK');if(published)rmSync(targetPath,{force:true});throw error;}
      }finally{rmSync(staging,{force:true});}
    }),
  };
  async close(){this.closed=true;await Promise.allSettled([...this.opening.values(),...this.lifecycleQueue.values()]);await Promise.all([...this.entries.values()].map(e=>e.service.close()));this.snapshots.close();this.resources.close();await this.instance.close();}
}
