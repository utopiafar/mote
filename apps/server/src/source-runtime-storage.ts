import type {Plugin} from '@deepseek-ai/cordis';
import type {HostScope} from '@mote/plugin-host';
import type {PluginScope} from '@mote/plugin-api/contracts';
import {StoreError,type Store} from './store.js';
import type {MaterialStore} from './materials.js';
import type {FileStore} from './files.js';
import type {MaterialMemoryWork} from './material-memory-work.js';
import {SourcePipelineRuntime} from './source-pipelines.js';
import {SourceStore} from './sources.js';
import {readCaptureContext,updateCaptureContext} from './capture-context.js';
import type {AuthorizationPlatform} from './plugins/authorization-platform.js';
import type {ExecutionPlatform} from './plugins/execution-platform.js';
import type {CommitAuthority,RequestAuthority,SourceIntake} from './plugins/central-contracts.js';
import type {SourceContextSnapshot} from '@mote/shared';

/** Trusted source owner only. The plugin receives the lifecycle port; this
 * owner keeps the real runtime and repositories out of plugin capabilities. */
export interface SourceRuntimeLifecyclePort {
  open(scope:HostScope):Promise<void>;
  start():void;
  quiesce():void;
  close():Promise<void>;
}

export type SourceControlPort={
  listSources():ReturnType<SourceStore['listSources']>;
  getSource(id:string):ReturnType<SourceStore['getSource']>;
  register(raw:unknown,authorize?:Parameters<SourceStore['register']>[1]):ReturnType<SourceStore['register']>;
  update(id:string,patch:Parameters<SourceStore['update']>[1],authorize?:Parameters<SourceStore['update']>[2]):ReturnType<SourceStore['update']>;
  updateContext(id:string,patch:Parameters<SourceStore['updateContext']>[1],authorize?:()=>void):ReturnType<SourceStore['updateContext']>;
  context(id:string):SourceContextSnapshot;
  listItems(args:Parameters<SourceStore['listItems']>[0]):ReturnType<SourceStore['listItems']>;
  getItem(sourceId:string,externalId:string):ReturnType<SourceStore['getItem']>;
  history(sourceId:string,externalId:string):ReturnType<SourceStore['history']>;
  summary():ReturnType<SourceStore['summary']>;
  captureContext(deviceId:string,channel:Parameters<typeof readCaptureContext>[3]):SourceContextSnapshot;
  updateCaptureContext(deviceId:string,channel:Parameters<typeof updateCaptureContext>[3],patch:Parameters<typeof updateCaptureContext>[4],authorize?:()=>void):SourceContextSnapshot;
};

export interface SourceIdentityPort {
  assertSources(port:SourceControlPort):void;
  assertBindings(input:{sources:SourceControlPort;capture:{assertRepositories():void;assertSourceRepository(control:SourceControlPort):void};authorization:{assertRepositories():void}}):void;
}

const controlRepositories=new WeakMap<SourceControlPort,{sources:SourceStore;files?:FileStore}>();
/** Trusted assembly binds the file repository after FilesSource constructs it. */
export function bindSourceFilesForControl(control:SourceControlPort,files:FileStore){
  const binding=controlRepositories.get(control);if(!binding)throw new StoreError('Source repository identity is unavailable',503);
  controlRepositories.set(control,{...binding,files});
}
/** Trusted capture only: compare exact repositories; never returns the stored classes. */
export function assertSourceRepositoryBinding(control:SourceControlPort,sources:SourceStore,files:FileStore){
  const binding=controlRepositories.get(control);
  if(!binding||binding.sources!==sources||binding.files!==undefined&&binding.files!==files)throw new StoreError('Capture intake repository association changed',503);
}

export type C10AuthorizationPort={
  bindRequest(input:Parameters<AuthorizationPlatform['bindRequest']>[0]):RequestAuthority;
  releaseRequest(request:RequestAuthority):void;
  assertRequest(request:RequestAuthority):void;
  assertOwnSource(request:RequestAuthority,sourceId:string):void;
  assertOwnCredentialSource(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>,sourceId:string):void;
  withSource<T>(request:RequestAuthority,sourceId:string,input:unknown,work:()=>Promise<T>):Promise<T>;
  sourceItem(sourceId:string,input:Parameters<SourceIntake['sourceItem']>[1],authority:CommitAuthority):ReturnType<SourceIntake['sourceItem']>;
  sourceBatch(sourceId:string,inputs:Parameters<SourceIntake['sourceBatch']>[1],authority:CommitAuthority):ReturnType<SourceIntake['sourceBatch']>;
  captureCommit():CommitAuthority;
  authenticate(header:string|undefined):ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>;
  isOwner(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>):boolean;
  assertActive(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>):void;
  assertOwnDevice(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>,input:{deviceId:string}):void;
  assertPlatform(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>,platform:unknown):void;
  assertRepositories():void;
};

export interface SourceRuntimeOwnerDependencies {
  readonly store:Store;
  readonly materials:MaterialStore;
  readonly memoryWork:MaterialMemoryWork;
  readonly execution:ExecutionPlatform;
}

export interface SourceRuntimeOwnerOptions {readonly plugins?:readonly Plugin[];}

const unavailable=()=>new StoreError('Source runtime is unavailable',503);

export function createSourceRuntimeOwner(dependencies:SourceRuntimeOwnerDependencies,options:SourceRuntimeOwnerOptions={}){
  const plugins=[...(options.plugins??[])];
  let prepared=false,admission:boolean|undefined,closing:Promise<void>|undefined;
  let runtime:SourcePipelineRuntime|undefined,handlers:ReturnType<ExecutionPlatform['handlersForAssembly']>|undefined;
  let sources:SourceStore|undefined,control:SourceControlPort|undefined,identity:SourceIdentityPort|undefined;

  const close=()=>{
    if(closing)return closing;admission=false;
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    closing=new Promise<void>((done,failed)=>{resolve=done;reject=failed;});
    const tasks=[()=>runtime?.close(),()=>handlers?.close()].map(dispose=>{try{return Promise.resolve(dispose());}catch(error){return Promise.reject(error);}});
    void Promise.allSettled(tasks).then(results=>{const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Source runtime disposal failed',{cause:errors[0]});}).then(resolve,reject);
    return closing;
  };

  async function prepare(scope:HostScope){
    if(runtime||handlers||closing)throw unavailable();
    try{
      scope.assertCurrent();
      const engine=dependencies.execution.trusted().executor;
      if(engine.store!==dependencies.store||dependencies.materials.store!==dependencies.store)throw new StoreError('Source runtime repository mismatch',503);
      handlers=dependencies.execution.handlersForAssembly(scope as PluginScope);
      runtime=new SourcePipelineRuntime(dependencies.store,dependencies.materials,plugins,scope,engine,dependencies.memoryWork,handlers);
      runtime.quiesce();await runtime.ready;scope.assertCurrent();if(closing)throw unavailable();prepared=true;
    }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Source runtime preparation and cleanup failed',{cause:error});}throw error;}
  }
  function start(){if(!prepared||closing||admission!==undefined)throw unavailable();runtime!.start();admission=true;}
  function quiesce(){if(admission){admission=false;runtime!.quiesce();handlers!.quiesce();}}

  const lifecycle=Object.freeze({
    open:prepare,
    start,
    quiesce,
    close,
  });

  const ownerRuntime=()=>{if(!runtime||!prepared||closing)throw unavailable();return runtime;};
  const sourceStoreForAssembly=()=>{
    if(!runtime||!prepared||closing)throw unavailable();
    return sources??=new SourceStore(dependencies.store,runtime,dependencies.memoryWork.inputs);
  };
  const sourceControlForAssembly=()=>{
    if(control)return control;
    const store=sourceStoreForAssembly();
    control=createSourceControl(store);
    return control;
  };
  const sourceIdentityForAssembly=()=>identity??=createSourceIdentity(sourceControlForAssembly());
  return Object.freeze({port:lifecycle,ownerRuntime,sourceStoreForAssembly,sourceControlForAssembly,sourceIdentityForAssembly,close});
}

export type SourceRuntimeOwner=ReturnType<typeof createSourceRuntimeOwner>;

export function createSourceControl(sources:SourceStore):SourceControlPort {
  const control:SourceControlPort=Object.freeze({
    listSources:()=>sources.listSources(),
    getSource:(id:string)=>sources.getSource(id),
    register:(raw:unknown,authorize?:Parameters<SourceStore['register']>[1])=>sources.register(raw,authorize),
    update:(id:string,patch:Parameters<SourceStore['update']>[1],authorize?:Parameters<SourceStore['update']>[2])=>sources.update(id,patch,authorize),
    updateContext:(id:string,patch:Parameters<SourceStore['updateContext']>[1],authorize?:()=>void)=>sources.updateContext(id,patch,authorize),
    context:(id:string)=>sources.contexts.current(id),
    listItems:(args:Parameters<SourceStore['listItems']>[0])=>sources.listItems(args),
    getItem:(sourceId:string,externalId:string)=>sources.getItem(sourceId,externalId),
    history:(sourceId:string,externalId:string)=>sources.history(sourceId,externalId),
    summary:()=>sources.summary(),
    captureContext:(deviceId:string,channel:Parameters<typeof readCaptureContext>[3])=>readCaptureContext(sources.store,sources,deviceId,channel),
    updateCaptureContext:(deviceId:string,channel:Parameters<typeof updateCaptureContext>[3],patch:Parameters<typeof updateCaptureContext>[4],authorize?:()=>void)=>updateCaptureContext(sources.store,sources,deviceId,channel,patch,authorize),
  });
  controlRepositories.set(control,{sources});
  return control;
}

function createSourceIdentity(control:SourceControlPort):SourceIdentityPort {
  return Object.freeze({
    assertSources(port:SourceControlPort){if(port!==control)throw new StoreError('Source repository identity changed',503);},
    assertBindings(input:{sources:SourceControlPort;capture:{assertRepositories():void;assertSourceRepository(control:SourceControlPort):void};authorization:{assertRepositories():void}}){
      if(input.sources!==control)throw new StoreError('Source repository identity changed',503);
      input.capture.assertRepositories();
      input.capture.assertSourceRepository(control);
      input.authorization.assertRepositories();
    },
  });
}

/** Trusted assembly-only fixed authorization port. It closes over the current
 * AuthorizationPlatform but exposes only the operations source integration uses; no class,
 * connection table or Store is returned. */
export function createC10AuthorizationPort(authorization:AuthorizationPlatform,store:Store):C10AuthorizationPort {
  const connections=()=>{
    const value=authorization.assembly.connections;
    if(!value)throw new StoreError('Source authorization connections are unavailable',503);
    return value;
  };
  return Object.freeze({
    bindRequest:(input:Parameters<AuthorizationPlatform['bindRequest']>[0])=>authorization.bindRequest(input),
    releaseRequest:(request:RequestAuthority)=>authorization.releaseRequest(request),
    assertRequest:(request:RequestAuthority)=>authorization.requests.assertCurrent(request),
    assertOwnSource:(request:RequestAuthority,sourceId:string)=>authorization.requests.assertOwnSource(request,sourceId),
    assertOwnCredentialSource:(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>,sourceId:string)=>connections().assertOwnSource(credential,sourceId),
    withSource:<T>(request:RequestAuthority,sourceId:string,input:unknown,work:()=>Promise<T>)=>authorization.withSource(request,sourceId,input,work),
    sourceItem:(sourceId:string,input:Parameters<SourceIntake['sourceItem']>[1],authority:CommitAuthority)=>authorization.sourceIntake.sourceItem(sourceId,input,authority),
    sourceBatch:(sourceId:string,inputs:Parameters<SourceIntake['sourceBatch']>[1],authority:CommitAuthority)=>authorization.sourceIntake.sourceBatch(sourceId,inputs,authority),
    captureCommit:()=>authorization.commits.capture(),
    authenticate:(header:string|undefined)=>connections().authenticate(header),
    isOwner:(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>)=>connections().isOwner(credential),
    assertActive:(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>)=>connections().assertActive(credential),
    assertOwnDevice:(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>,input:{deviceId:string})=>connections().assertOwnDevice(credential,input),
    assertPlatform:(credential:NonNullable<ReturnType<NonNullable<AuthorizationPlatform['assembly']['connections']>['authenticate']>>,platform:unknown)=>connections().assertPlatform(credential,platform),
    assertRepositories:()=>{if(!authorization.assembly.connections?.sameVault(store))throw new StoreError('Source authorization repository mismatch',503);},
  });
}
