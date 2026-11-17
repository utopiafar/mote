import type {CaptureInput} from '@mote/shared';
import {StoreError,type Range,type EvidenceStore as Store} from './evidence-store.js';
import {IngressService} from './ingress.js';
import type {SourceStore} from './sources.js';
import type {FileStore} from './files.js';
import type {MaterialStore} from './materials.js';
import type {MaterialMemoryWork} from './material-memory-work.js';
import type {MemoryInputAuthorization} from './memory-input-authorization.js';
import type {AuthorizationPlatform,AuthorizationRepositories} from './plugins/authorization-platform.js';
import {assertSourceRepositoryBinding,type SourceControlPort} from './source-runtime-storage.js';
import type {CaptureIntake,SourceIntake,SourceRepository,CommitAuthority,RequestAuthority} from './plugins/central-contracts.js';

export type CapturePageQuery=Range;
export type CapturePage=ReturnType<Store['list']>;
export type CaptureC04Port={
  readonly captureIntake:Readonly<{
    capture(input:CaptureInput,authority:CommitAuthority):ReturnType<CaptureIntake['capture']>;
    captureSettled(inputs:CaptureInput[],authority:CommitAuthority):ReturnType<CaptureIntake['captureSettled']>;
  }>;
  readonly sourceIntake:Readonly<{
    sourceItem(sourceId:string,input:Parameters<SourceIntake['sourceItem']>[1],authority:CommitAuthority):ReturnType<SourceIntake['sourceItem']>;
    sourceBatch(sourceId:string,inputs:Parameters<SourceIntake['sourceBatch']>[1],authority:CommitAuthority):ReturnType<SourceIntake['sourceBatch']>;
  }>;
  readonly commits:Readonly<{capture():CommitAuthority}>;
  readonly requests:Readonly<{
    authenticate(authorization:string|undefined):RequestAuthority|undefined;
    assertCurrent(authority:RequestAuthority):void;
    assertCapture(authority:RequestAuthority,input:CaptureInput):void;
    assertOwnSource(authority:RequestAuthority,sourceId:string):void;
    assertOwnDevice(authority:RequestAuthority,input:{deviceId:string}):void;
    assertOwnPlatform(authority:RequestAuthority,platform:unknown):void;
  }>;
  bindRequest(input:Parameters<AuthorizationPlatform['bindRequest']>[0]):RequestAuthority;
  releaseRequest(request:RequestAuthority):void;
  captureCommit():CommitAuthority;
  withCapture<T>(request:RequestAuthority,input:CaptureInput|CaptureInput[],work:()=>Promise<T>):Promise<T>;
  withSource<T>(request:RequestAuthority,sourceId:string,input:unknown,work:()=>Promise<T>):Promise<T>;
};

export interface CapturePort {
  capture(input:CaptureInput,authorize?:()=>void):ReturnType<IngressService['capture']>;
  captureSettled(inputs:CaptureInput[],authorize?:()=>void):ReturnType<IngressService['captureSettled']>;
  sourceItem(sourceId:string,input:Parameters<IngressService['sourceItem']>[1],authorize?:()=>void):ReturnType<IngressService['sourceItem']>;
  sourceBatch(sourceId:string,inputs:Parameters<IngressService['sourceBatch']>[1],authorize?:()=>void):ReturnType<IngressService['sourceBatch']>;
  page(args:CapturePageQuery):CapturePage;
  assertRepositories():void;
  assertSourceRepository(control:SourceControlPort):void;
  readonly sources:SourceRepository;
}

export interface CaptureOwnerDependencies {
  readonly store:Store;
  readonly sources:SourceStore;
  readonly files:FileStore;
  readonly materials:MaterialStore;
  readonly memoryInputs?:MemoryInputAuthorization;
  readonly memoryWork?:MaterialMemoryWork;
}

export function createCaptureOwner(dependencies:CaptureOwnerDependencies){
  const {store,sources,files,materials}=dependencies;
  const ingress=new IngressService(store,sources,files);
  const sourceRepository:SourceRepository=Object.freeze({
    register:(raw:unknown)=>sources.register(raw),
    getSource:(id:string)=>sources.getSource(id),
    listSources:()=>sources.listSources(),
    getItem:(sourceId:string,externalId:string)=>sources.getItem(sourceId,externalId),
    listItems:(args:Parameters<SourceStore['listItems']>[0])=>sources.listItems(args),
    history:(sourceId:string,externalId:string)=>sources.history(sourceId,externalId),
  });
  const port:CapturePort=Object.freeze({
    capture:(input:CaptureInput,authorize?:()=>void)=>ingress.capture(input,authorize),
    captureSettled:(inputs:CaptureInput[],authorize?:()=>void)=>ingress.captureSettled(inputs,authorize),
    sourceItem:(sourceId:string,input:Parameters<IngressService['sourceItem']>[1],authorize?:()=>void)=>ingress.sourceItem(sourceId,input,authorize),
    sourceBatch:(sourceId:string,inputs:Parameters<IngressService['sourceBatch']>[1],authorize?:()=>void)=>ingress.sourceBatch(sourceId,inputs,authorize),
    page:(args:CapturePageQuery)=>store.list(args),
    assertRepositories(){
      if(sources.store!==store||files.store!==store||materials.store!==store)throw new StoreError('Capture intake repository mismatch',503);
    },
    assertSourceRepository(control:SourceControlPort){
      assertSourceRepositoryBinding(control,sources,files);
    },
    sources:sourceRepository,
  });
  const bindRepositories=()=>{
    const value:AuthorizationRepositories={sources,files,materials,ingress,...(dependencies.memoryInputs?{memoryInputs:dependencies.memoryInputs}:{}),...(dependencies.memoryWork?{memoryWork:dependencies.memoryWork}:{})};
    return value;
  };
  const c04Port=(authorization:AuthorizationPlatform):CaptureC04Port=>Object.freeze({
    captureIntake:Object.freeze({
      capture:(input:CaptureInput,authority:CommitAuthority)=>authorization.captureIntake.capture(input,authority),
      captureSettled:(inputs:CaptureInput[],authority:CommitAuthority)=>authorization.captureIntake.captureSettled(inputs,authority),
    }),
    sourceIntake:Object.freeze({
      sourceItem:(sourceId:string,input:Parameters<SourceIntake['sourceItem']>[1],authority:CommitAuthority)=>authorization.sourceIntake.sourceItem(sourceId,input,authority),
      sourceBatch:(sourceId:string,inputs:Parameters<SourceIntake['sourceBatch']>[1],authority:CommitAuthority)=>authorization.sourceIntake.sourceBatch(sourceId,inputs,authority),
    }),
    commits:Object.freeze({capture:()=>authorization.commits.capture()}),
    requests:Object.freeze({
      authenticate:(value:string|undefined)=>authorization.requests.authenticate(value),
      assertCurrent:(authority:RequestAuthority)=>authorization.requests.assertCurrent(authority),
      assertCapture:(authority:RequestAuthority,input:CaptureInput)=>authorization.requests.assertCapture(authority,input),
      assertOwnSource:(authority:RequestAuthority,sourceId:string)=>authorization.requests.assertOwnSource(authority,sourceId),
      assertOwnDevice:(authority:RequestAuthority,input:{deviceId:string})=>authorization.requests.assertOwnDevice(authority,input),
      assertOwnPlatform:(authority:RequestAuthority,platform:unknown)=>authorization.requests.assertOwnPlatform(authority,platform),
    }),
    bindRequest:(input:Parameters<AuthorizationPlatform['bindRequest']>[0])=>authorization.bindRequest(input),
    releaseRequest:(request:RequestAuthority)=>authorization.releaseRequest(request),
    captureCommit:()=>authorization.commits.capture(),
    withCapture:<T>(request:RequestAuthority,input:CaptureInput|CaptureInput[],work:()=>Promise<T>)=>authorization.withCapture(request,input,work),
    withSource:<T>(request:RequestAuthority,sourceId:string,input:unknown,work:()=>Promise<T>)=>authorization.withSource(request,sourceId,input,work),
  });
  return Object.freeze({
    port,
    ingress,
    bindRepositories(authorization:AuthorizationPlatform){authorization.bindRepositories(bindRepositories());},
    c04Port,
    assertRepositories:()=>port.assertRepositories(),
  });
}

export type CaptureOwner=ReturnType<typeof createCaptureOwner>;
