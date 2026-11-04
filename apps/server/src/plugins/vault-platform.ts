import type {PluginLifecycle,PluginScope} from '@mote/plugin-api/contracts';
import type {ManifestContribution} from '@mote/plugin-api';
import type {HostPluginContext} from '@mote/plugin-host';
import {join} from 'node:path';
import {Store,StoreError} from '../store.js';
import {SourceStore} from '../sources.js';
import {FileStore} from '../files.js';
import {MaterialStore} from '../materials.js';
import {ArchivedFileStore} from '../archived-files.js';
import {ContentStorageService} from '../content-storage.js';
import type {ConfigService} from '../config-service.js';
import {MaintenanceWorker} from '../maintenance.js';
import {contributeDomainRoutes} from './domain-routes.js';
import {vaultStorageRoutes} from './vault-storage-routes.js';
import {centralServices,type CommitAuthority,type CommitAuthorization,type VaultTransactions,type MaterialRepositoryRead,type MaterialPublication,type ArchivedContentRead} from './central-contracts.js';

/** Private host configuration, never a Manifest configuration value or a wire DTO. */
export interface VaultPlatformOptions {
  readonly dataDir:string;
  readonly dataKey?:string;
  readonly contentEncryptionEnabled?:boolean;
  readonly maxStorageBytes?:number;
  readonly embeddingEnabled?:boolean;
  readonly maintenance?:boolean;
}
export interface VaultFileRepository {
  begin(input:Parameters<FileStore['begin']>[0],authority:CommitAuthority):ReturnType<FileStore['begin']>;
  part(id:string,part:number,bytes:Buffer,authority:CommitAuthority):ReturnType<FileStore['part']>;
  commit(id:string,authority:CommitAuthority):ReturnType<FileStore['commit']>;
  bytes(id:string):Iterable<Buffer>;
}
/** Trusted factory assembly only; never returned by an ordinary published port. */
export interface VaultRepositoryAccess {
  readonly transactions:VaultTransactions;
  readonly sources:{register(input:Parameters<SourceStore['register']>[0],authority:CommitAuthority):ReturnType<SourceStore['register']>};
  readonly files:VaultFileRepository;
  readonly materials:MaterialRepositoryRead & MaterialPublication;
  readonly originals:ArchivedContentRead & {put(input:Parameters<ArchivedFileStore['put']>[0],authority:CommitAuthority):ReturnType<ArchivedFileStore['put']>};
  readonly content:{snapshot():ReturnType<ContentStorageService['snapshot']>};
  stats():ReturnType<Store['stats']>;
  /** Existing bounded portable export; not an atomic database/blob/provider backup. */
  exportPortable(maxBytes:number):ReturnType<Store['exportArchive']>;
  /** Invalidates this access only. It neither closes sibling accesses nor deletes data. */
  release():void;
}
/** H03 owns the package Manifest. This is its actual data-contribution fragment only. */
export const vaultPlatformContribution={
  id:'vault-platform',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'service',id:centralServices.commitAuthorization.id,version:centralServices.commitAuthorization.apiVersion}],
  provides:[centralServices.contentRead].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const vaultPlatformDeclaration={id:vaultPlatformContribution.id,apiVersion:'1'} as const;
export const vaultPlatformReplacement='restart' as const;
export interface VaultPlatform extends PluginLifecycle {
  /** Trusted domain-factory wiring only. Caller-supplied scopes are not a public capability. */
  repositoriesForAssembly(scope:PluginScope):VaultRepositoryAccess;
  /** Vault-owned content-encryption/decryption control; never a second instance. */
  readonly contentStorage:ContentStorageService;
  close():Promise<void>;
}

/** Trusted H05 bootstrap bridge only. Not a published service, SDK, ordinary plugin
 * capability or replacement for domain authorization. It preserves the current legacy
 * composition until domain factories replace it. Caller-supplied Store is borrowed. */
export function createVaultPlatformAssembly(options:VaultPlatformOptions,dependencies:{store?:Store;configService?:ConfigService;onContentEncryptionApplied?:(enabled:boolean)=>void}={}){
  const config={...options},borrowed=dependencies.store;
  if(!config.dataDir||config.maxStorageBytes!==undefined&&(!Number.isSafeInteger(config.maxStorageBytes)||config.maxStorageBytes<0))throw new StoreError('Invalid vault configuration');
  let store:Store|undefined,archivedFiles:ArchivedFileStore|undefined,content:ContentStorageService|undefined,maintenance:MaintenanceWorker|undefined;
  let phase:'created'|'prepared'|'closing'|'closed'='created',closing:Promise<void>|undefined,accessorsClosing:Promise<void>|undefined;
  const assertPrepared=()=>{if(phase!=='prepared')throw new StoreError('Vault assembly is unavailable',503);};
  const stopAccessors=()=>accessorsClosing??=(async()=>{
    const errors:unknown[]=[];
    try{await maintenance?.close();}catch(error){errors.push(error);}
    try{await content?.close();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Vault accessors failed to stop');
  })();
  const close=()=>closing??=(async()=>{
    phase='closing';const errors:unknown[]=[];
    try{await stopAccessors();}catch(error){errors.push(error);}
    try{if(!borrowed)store?.close();}catch(error){errors.push(error);}
    phase='closed';if(errors.length)throw new AggregateError(errors,'Vault assembly disposal failed');
  })();
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw new StoreError('Vault assembly is unavailable',503);
      try{
        store=borrowed??new Store(config.dataDir,{dataKey:config.dataKey,contentEncryptionEnabled:config.contentEncryptionEnabled,maxStorageBytes:config.maxStorageBytes,embeddingEnabled:config.embeddingEnabled,maintenance:config.maintenance});
        archivedFiles=new ArchivedFileStore(store);
        // Content conversion walks only the two fixed managed object roots; the
        // vault owns the service, so no feature adapter constructs it later.
        content=new ContentStorageService(store,{objects:join(store.directory,'files','objects'),uploads:join(store.directory,'files','uploads')},archivedFiles,dependencies.configService,enabled=>{maintenance?.configureContentEncryption(enabled);dependencies.onContentEncryptionApplied?.(enabled);});
        phase='prepared';
      }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Vault assembly preparation and cleanup failed',{cause:error});}throw error;}
    },
    get store(){assertPrepared();return store!;},
    get archivedFiles(){assertPrepared();return archivedFiles!;},
    get contentStorage(){assertPrepared();return content!;},
    startMaintenance(){
      assertPrepared();if(accessorsClosing)throw new StoreError('Vault assembly is stopping',503);
      if(config.maintenance&&!maintenance)maintenance=new MaintenanceWorker({...config});return maintenance;
    },
    stopAccessors,close,
  });
}

/** Trusted warehouse assembly only, not a public service: domain SQL remains in its existing repositories. The trusted
 * caller supplies the fixed C04 verifier; no consumer can pass an issuer or callback.
 * This adapter checks its opaque reference at the synchronous transaction boundary.
 * Actual request/job resource/action/owner admission still belongs to C04/domain writers;
 * this module is not their implementation or proof of runtime authorization. */
export function createVaultPlatform(options:VaultPlatformOptions,authorization:CommitAuthorization):VaultPlatform {
  // Capture private primitive options, so later host mutations cannot retarget this instance.
  const config={...options};
  if(!authorization||typeof authorization.assertCurrent!=='function')throw new StoreError('C04 commit verifier is unavailable',503);
  const verify=authorization.assertCurrent.bind(authorization);
  let phase:'created'|'prepared'|'active'|'quiescing'|'draining'|'stopped'|'disposed'='created';
  let store:Store|undefined,sources:SourceStore|undefined,files:FileStore|undefined,materials:MaterialStore|undefined;
  let originals:ArchivedFileStore|undefined,content:ContentStorageService|undefined;
  const assembly=createVaultPlatformAssembly(config);
  let closing:Promise<void>|undefined,transactionId=0;
  const pending=new Set<Promise<unknown>>();
  const readers=new Set<Iterator<Buffer>>();
  function closeReader(reader:Iterator<Buffer>){
    if(!readers.delete(reader))return;reader.return?.();
  }
  const unavailable=()=>new StoreError('Vault scope is unavailable',503);
  function track<T>(work:Promise<T>):Promise<T>{
    pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
  }
  function acquire(scope:PluginScope):VaultRepositoryAccess {
    if(phase!=='active')throw unavailable();
    scope.assertCurrent();scope.signal.throwIfAborted();
    let released=false;const ownedReaders=new Set<Iterator<Buffer>>();
    const release=()=>{
      released=true;const errors:unknown[]=[];
      for(const reader of ownedReaders)try{closeReader(reader);}catch(error){errors.push(error);}
      ownedReaders.clear();if(errors.length)throw new AggregateError(errors,'Vault reader disposal failed');
    };
    scope.defer(release);
    const current=(accepted=false)=>{
      if(released||phase!=='active'&&phase!=='quiescing'&&!(accepted&&phase==='draining'))throw unavailable();
      scope.assertCurrent();scope.signal.throwIfAborted();
    };
    const assertAuthority=(authority:CommitAuthority)=>{current();verify(authority);};
    const transaction:VaultTransactions['transaction']=(authority,work)=>{
      assertAuthority(authority);
      const db=store!.db,nested=db.isTransaction,name=`vault_${++transactionId}`;
      db.exec(nested?`SAVEPOINT ${name}`:'BEGIN IMMEDIATE');
      try{
        assertAuthority(authority);const value=work();
        if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw new StoreError('Vault transactions must be synchronous');
        assertAuthority(authority);db.exec(nested?`RELEASE ${name}`:'COMMIT');return value;
      }catch(error){
        try{db.exec(nested?`ROLLBACK TO ${name}; RELEASE ${name}`:'ROLLBACK');}
        catch(cleanup){throw new AggregateError([error,cleanup],'Vault transaction and rollback failed',{cause:error});}
        throw error;
      }
    };
    const read=<T>(work:()=>T):T=>{current();return work();};
    return Object.freeze({
      transactions:Object.freeze({transaction}),
      sources:Object.freeze({register:(input:unknown,authority:CommitAuthority)=>transaction(authority,()=>sources!.register(input))}),
      files:Object.freeze({
        begin:(input:unknown,authority:CommitAuthority)=>transaction(authority,()=>files!.begin(input,()=>assertAuthority(authority))),
        part:(id:string,part:number,bytes:Buffer,authority:CommitAuthority)=>transaction(authority,()=>files!.part(id,part,bytes,()=>assertAuthority(authority))),
        commit:(id:string,authority:CommitAuthority)=>{
          assertAuthority(authority);
          return track(files!.commit(id,()=>{current(true);verify(authority);}));
        },
        *bytes(id:string){
          current();const iterator=files!.bytes(id)[Symbol.iterator]();readers.add(iterator);ownedReaders.add(iterator);
          try{while(true){current();const next=iterator.next();if(next.done)return;yield next.value;}}
          finally{ownedReaders.delete(iterator);closeReader(iterator);}
        },
      }),
      materials:Object.freeze({
        get:(...args:Parameters<MaterialStore['get']>)=>read(()=>materials!.get(...args)),
        read:(...args:Parameters<MaterialStore['read']>)=>read(()=>materials!.read(...args)),
        members:(...args:Parameters<MaterialStore['members']>)=>read(()=>materials!.members(...args)),
        input:(...args:Parameters<MaterialStore['input']>)=>read(()=>materials!.input(...args)),
        isCurrentEvidence:(...args:Parameters<MaterialStore['isCurrentEvidence']>)=>read(()=>materials!.isCurrentEvidence(...args)),
        contextForEvidence:(...args:Parameters<MaterialStore['contextForEvidence']>)=>read(()=>materials!.contextForEvidence(...args)),
        publish:(draft:Parameters<MaterialStore['publish']>[0],settings:Parameters<MaterialStore['publish']>[1],authority:CommitAuthority)=>transaction(authority,()=>materials!.publish(draft,settings)),
      }),
      originals:Object.freeze({
        get:(id:string)=>read(()=>originals!.get(id)),read:(id:string)=>read(()=>originals!.read(id)),
        listForCapture:(id:string)=>read(()=>originals!.listForCapture(id)),
        put:(input:Parameters<ArchivedFileStore['put']>[0],authority:CommitAuthority)=>transaction(authority,()=>originals!.put(input)),
      }),
      content:Object.freeze({snapshot:()=>read(()=>content!.snapshot())}),
      stats:()=>read(()=>store!.stats()),exportPortable:(maxBytes:number)=>read(()=>store!.exportArchive(maxBytes)),release,
    });
  }
  async function dispose(){
    if(closing)return closing;
    if(phase!=='stopped')phase='draining';
    closing=(async()=>{
      const errors:unknown[]=[];
      const clean=async(work:()=>unknown|Promise<unknown>)=>{try{await work();}catch(error){errors.push(error);}};
      await clean(()=>assembly.stopAccessors());
      for(const reader of readers)await clean(()=>closeReader(reader));
      await Promise.allSettled([...pending]);
      await clean(()=>files?.close());
      await clean(()=>assembly.close());phase='disposed';
      if(errors.length)throw new AggregateError(errors,'Vault disposal failed');
    })();
    return closing;
  }
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{
        await assembly.prepare();
        if(phase!=='created')throw unavailable();
        store=assembly.store;originals=assembly.archivedFiles;content=assembly.contentStorage;
        sources=new SourceStore(store);files=new FileStore(store,sources);
        materials=new MaterialStore(store);
        phase='prepared';
      }catch(error){
        try{await dispose();}catch(cleanup){throw new AggregateError([error,cleanup],'Vault preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){
      if(phase!=='prepared')throw unavailable();
      assembly.startMaintenance();
      phase='active';
    },
    quiesce(){if(phase==='active')phase='quiescing';},
    async stop(){if(phase!=='disposed')phase='stopped';await dispose();},dispose,close:dispose,repositoriesForAssembly:acquire,
    get contentStorage(){if(phase==='created'||phase==='disposed')throw unavailable();return assembly.contentStorage;},
  });
}

/** Public contribution exposes only flat read methods guarded by the H04 caller lease.
 * No consumer scope, nested repository, iterator, transaction or writer leaves this boundary.
 * Actual domain writers stay in trusted factory assembly until C04/owner checks are wired. */
export function createVaultPlatformFactory(options:VaultPlatformOptions,authorization:CommitAuthorization){
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createVaultPlatform(options,authorization);context.scope.defer(()=>platform.close());
    return {
      prepare:()=>platform.prepare(),
      quiesce:(reason)=>platform.quiesce(reason),stop:(reason)=>platform.stop(reason),dispose:()=>platform.dispose(),
      start:async()=>{
        await platform.start();const access=platform.repositoriesForAssembly(context.scope);
        // The vault owns the storage transport; the mounted table resolves the
        // current activation instead of installing a second copy on re-enable.
        contributeDomainRoutes(context.scope.cordis,{'mote.storage':vaultStorageRoutes(()=>platform.contentStorage)});
        context.provide(vaultPlatformContribution.id,centralServices.contentRead,Object.freeze({get:access.originals.get,read:access.originals.read,listForCapture:access.originals.listForCapture}));
      },
    };
  };
}
