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
import {ModelResources,userModelFields,removeCredentials,type UserModelConfiguration} from './model-resources.js';

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
export type ModelLease=Readonly<{id:string;deploymentId:string;userId:string;operationId:string;feature:ModelFeature;revision:number;instanceRevision:number;reference:Readonly<{kind:'shared'|'personal';id:string}>;provider:string;model:string}>;
type PrivateLease={context:UserContext;generation:number;sharedGeneration?:number;settings:ModelSettings;price?:ModelPrice;configuration:ConfigDocument};
export type UserConfigurationService=ReturnType<Configurations['forUser']>;

/** Host-owned per-account ConfigService instances. No request path or userId is
 * accepted by this API. Trusted installed modules register ordinary domains on
 * the same service; the private resolver never expands instance environment. */
export class Configurations {
  readonly resources:ModelResources;
  private readonly entries=new Map<string,Entry>();
  private readonly opening=new Map<string,Promise<Entry>>();
  private readonly lifecycleQueue=new Map<string,Promise<void>>();
  private readonly leases=new WeakMap<ModelLease,PrivateLease>();
  private readonly domains=new Map<string,(context:UserDataSubject)=>ConfigDomainRegistration>();
  private closed=false;
  private constructor(private readonly options:{directory:string;db:DatabaseSync;authority:UserContextAuthority;accounts?:Accounts;lifecycleAuthority?:LifecycleAuthority},readonly instance:ConfigService){
    this.resources=new ModelResources(instance);
    options.db.exec(`CREATE TABLE IF NOT EXISTS user_configuration_state(user_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,restore_operation TEXT);
      CREATE TABLE IF NOT EXISTS user_model_usage(user_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS user_configuration_restore_journal(user_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,generation INTEGER NOT NULL,target_hash TEXT,staging_id TEXT NOT NULL);`);
  }
  static async open(options:Configurations['options']&{instancePath?:string;instanceDocument?:ConfigDocument}){
    const instance=new ConfigService({path:options.instancePath??join(options.directory,'instance.yaml'),initialDocument:options.instanceDocument??{version:1,revision:0}});
    registerBuiltinDomains(instance);
    const service=new Configurations(options,instance);
    try{await instance.initialize();await instance.startWatching();return service;}
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
  private async entry(context:UserDataSubject):Promise<Entry>{
    this.assertSubject(context,'export');const state=this.state(context.userId);this.assertGeneration(context.userId,state.generation);
    const accessKey='credentialId' in context?'account:'+context.authorizationEpoch:'lifecycle:'+context.operationId;
    const prior=this.entries.get(context.userId);if(prior){
      try{await prior.initializing;}catch(error){if(prior.accessKey===accessKey)throw error;return this.entry(context);}
      this.assertSubject(context,'export');
      if(this.entries.get(context.userId)!==prior)return this.entry(context);
      if(prior.accessKey===accessKey&&('credentialId' in context||prior.subject===context)){this.assertGeneration(context.userId,prior.generation);return prior;}
      this.entries.delete(context.userId);await prior.service.close();return this.entry(context);
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
      entry.initializing=(async()=>{await service.initialize();if(!lifecycle)await service.startWatching();guard();})();
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
      replace:async(domain:string,value:unknown,revision:number)=>{current();const {service}=await this.entry(context);await service.replace(domain,value,revision,current);current();return safeView(service);},
      reload:async()=>{current();const {service}=await this.entry(context);await service.reload(current);current();return safeView(service);},
      models:async()=>{current();const {service}=await this.entry(context);current();return {shared:this.resources.listShared(),personal:(safeView(service).domains.find(d=>d.id==='models')!.effective as UserModelConfiguration).profiles,selections:service.current<UserModelConfiguration>('models').selections};},
      lease:(feature:ModelFeature,operationId:string)=>this.lease(context,feature,operationId),
      usage:()=>{current();this.assertGeneration(context.userId,this.state(context.userId).generation);return this.usage(context.userId);},
    });
  }
  private usage(userId:string){
    const items=(this.options.db.prepare('SELECT json FROM user_model_usage WHERE user_id=? ORDER BY id').all(userId) as {json:string}[]).map(r=>JSON.parse(r.json) as UsageReceipt);
    return {items,total:usageTotals(items)};
  }
  async lease(context:UserContext,feature:ModelFeature,operationId:string):Promise<ModelLease>{
    this.options.authority.assert(context);if(!MODEL_FEATURES.includes(feature)||!validScopeId(operationId))throw new ConfigServiceError('config_invalid');
    const entry=await this.entry(context);this.options.authority.assert(context);
    const {settings,reference}=this.resources.resolve(entry.service.current('models'),feature);
    const prices=entry.service.current<z.infer<typeof priceDomain>>('modelPrices').items;
    const lease=Object.freeze({id:randomUUID(),deploymentId:context.deploymentId,userId:context.userId,operationId,feature,revision:entry.service.revision,instanceRevision:this.instance.revision,reference:Object.freeze(reference),provider:settings.provider,model:settings.model});
    this.leases.set(lease,{context,generation:entry.generation,...(reference.kind==='shared'?{sharedGeneration:this.resources.generation(reference.id)}:{}),settings:clone(settings),price:clone(prices.find(p=>p.provider===settings.provider&&p.model===settings.model)),configuration:entry.service.document()});
    return lease;
  }
  /** M05/M06/M07 hold a genuine lease, not a deserialized receipt. Logout does
   * not cancel admitted work; disable/reset/delete fences all late publications.
   * Shared catalog removal or a changed resource also revokes its leased access. */
  assertLease(lease:ModelLease){
    const privateLease=this.leases.get(lease);if(!privateLease)throw new ScopeError('invalid_identity',401);
    this.assertGeneration(lease.userId,privateLease.generation);this.accountFence(privateLease.context);
    if(lease.reference.kind==='shared'){
      if(privateLease.sharedGeneration!==this.resources.generation(lease.reference.id))throw new ScopeError('invalid_identity',401);
      const actual=this.resources.resolve({profiles:[],selections:{[lease.feature]:lease.reference}},lease.feature);
      if(JSON.stringify(actual.settings)!==JSON.stringify(privateLease.settings))throw new ScopeError('invalid_identity',401);
    }
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
        this.options.db.prepare('DELETE FROM user_configuration_restore_journal WHERE user_id=?').run(context.userId);this.options.db.exec('COMMIT');
      }catch(error){this.options.db.exec('ROLLBACK');throw error;}
      await this.forget(context.userId);this.assertSubject(context,'delete');
      rmSync(this.path(context.userId),{recursive:true,force:true});this.options.db.prepare('DELETE FROM user_model_usage WHERE user_id=?').run(context.userId);
      return {status:'complete' as const,operationId};
    }),
    restoreUser:async(context,archive,operationId)=>this.serializeLifecycle(context.userId,async()=>{
      this.assertSubject(context,'restore');
      if(!validScopeId(operationId)||archive.domain!=='configuration'||archive.version!==1||archive.deploymentId!==context.deploymentId||archive.userId!==context.userId)throw new ConfigServiceError('config_invalid');
      const payload=z.object({document:z.object({version:z.literal(1),revision:nonnegative,models:this.resources.schema(),modelPrices:priceDomain}).passthrough(),usage:z.array(z.unknown()).max(100000),credentialsIncluded:z.literal(false),omittedDomains:z.array(z.string()).length(0)}).strict().parse(archive.payload);
      for(const id of this.domains.keys())if(!Object.hasOwn(payload.document,id))throw new ConfigServiceError('config_invalid');
      const restoreDomains:ConfigDomainRegistration[]=[];
      for(const key of Object.keys(payload.document))if(!['version','revision','models','modelPrices'].includes(key)){
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
  async close(){this.closed=true;await Promise.allSettled([...this.opening.values(),...this.lifecycleQueue.values()]);await Promise.all([...this.entries.values()].map(e=>e.service.close()));this.resources.close();await this.instance.close();}
}
