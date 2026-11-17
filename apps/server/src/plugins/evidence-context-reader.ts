import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract} from '@mote/plugin-api/contracts';
import type {ContextReader} from '@mote/agent';
import type {FastifyInstance} from 'fastify';
import type {CentralDomainPlugin} from '../domain-activation.js';
import {StoreError} from '../evidence-store.js';
import type {ContextTreesReadCapability} from '../context-trees.js';
import type {EvidenceReaderAgentOptions,EvidenceReaderFacade} from '../evidence-reader.js';
import type {CaptureRead,CaptureContextRead,MaterialRead,MemoryRead,MemoryReadSnapshot,MemoryReadSnapshots,MemoryInputSelection} from '../evidence-read-ports.js';
import {centralServices,type ContextNavigationRead,type ContextTreesRead} from './central-contracts.js';

/** The package Manifest is host-owned; this is the actual data-contribution fragment.
 * The factory provides the single Evidence/context read aggregation; it never
 * publishes a Store, source writer, indexer or permission table. */
export const evidenceContextReaderContribution={
  id:'evidence-context-reader',version:'1.0.0',surface:'data',runtime:'host',
  requires:[],
  provides:[
    centralServices.captureRead,centralServices.captureContextRead,
    centralServices.contextNavigationRead,centralServices.contextTreesRead,
    centralServices.materialRead,centralServices.memoryRead,
    centralServices.memorySnapshots,
  ].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const evidenceContextReaderDeclaration={id:evidenceContextReaderContribution.id,apiVersion:'1'} as const;
export const evidenceContextReaderReplacement='hot' as const;

/** Fixed per-read facade plus the trusted route producer. No Store, repository,
 * MemoryStore, SourceStore or raw EvidenceReader enters this plugin. */
export interface EvidenceContextReaderDependencies {
  readonly reader:EvidenceReaderFacade;
  readonly contextTrees:ContextTreesReadCapability;
  readonly mountRoutes:(app:FastifyInstance)=>void;
}

export interface EvidenceContextReaderPorts {
  readonly captureRead:CaptureRead;
  readonly captureContextRead:CaptureContextRead;
  readonly contextNavigationRead:ContextNavigationRead;
  readonly contextTreesRead:ContextTreesRead;
  readonly materialRead:MaterialRead;
  readonly memoryRead:MemoryRead;
  readonly memorySnapshots:MemoryReadSnapshots;
  readonly memoryInputSelection:MemoryInputSelection;
}

export interface EvidenceContextReader {
  readonly ports:EvidenceContextReaderPorts;
  /** Only the context-tree registry crosses this boundary; the raw reader is
   * retained by trusted assembly for existing host consumers. */
  readonly assembly:{readonly contextTrees:ContextTreesReadCapability};
  agent(options:EvidenceReaderAgentOptions):ContextReader;
  /** Mount the trusted context route producer once, before the host listens. */
  routes(app:FastifyInstance):void;
  /** Idempotent. Revokes agent views/ports and releases this reader's retained
   * snapshots; borrowed repositories keep their own lifetime. */
  dispose():void;
  readonly disposed:boolean;
}

export function createEvidenceContextReader(deps:EvidenceContextReaderDependencies):EvidenceContextReader {
  const {reader,contextTrees}=deps;
  let disposed=false;
  const mounted=new WeakSet<FastifyInstance>();
  // The memoryBindings port is used by ContextTreeRegistry.page and other host
  // consumers that own their snapshot only for one read. Track these so a
  // factory disposal releases whichever are still outstanding, while a normal
  // caller release removes one immediately and is never double-released.
  const bindingSnapshots=new Set<MemoryReadSnapshot>();
  const trackBindingSnapshot=(snapshot:MemoryReadSnapshot):MemoryReadSnapshot=>{
    let released=false;
    const tracked:MemoryReadSnapshot={...snapshot,release:()=>{
      if(released)return;
      released=true;
      if(!bindingSnapshots.delete(tracked))return;
      snapshot.release();
    }};
    bindingSnapshots.add(tracked);
    return tracked;
  };
  const assertOpen=()=>{if(disposed||reader.disposed)throw new StoreError('Evidence context reader is unavailable',503);};
  const fenced=<T>(read:()=>T):T=>{
    assertOpen();
    const value=read();
    if(value&&typeof (value as {then?:unknown}).then==='function')return Promise.resolve(value).then(result=>{assertOpen();return result;}) as T;
    return value;
  };
  const ports:EvidenceContextReaderPorts={
    captureRead:{
      evidence:(refs,scope)=>fenced(()=>reader.evidence(refs,scope)),
      archivedEvidence:(refs,scope)=>fenced(()=>reader.archivedEvidence(refs,scope)),
      imageReference:(ref,scope)=>fenced(()=>reader.imageReference(ref,scope)),
      context:records=>fenced(()=>reader.context(records)),
    },
    captureContextRead:{
      evidence:(refs,scope)=>fenced(()=>reader.evidence(refs,scope)),
      records:(args,search)=>fenced(()=>reader.records(args,search)),
      search:args=>fenced(()=>reader.search(args)),
      artifact:(ref,scope)=>fenced(()=>reader.artifact(ref,scope)),
    },
    contextNavigationRead:{
      segments:args=>fenced(()=>reader.segments(args)),
      catalogAsync:(args,snapshot)=>fenced(()=>reader.catalogAsync(args,snapshot)),
    },
    contextTreesRead:{
      catalog:()=>fenced(()=>contextTrees.catalog()),
      page:(treeReader,treeId,nodeId,raw,ownerArchive)=>fenced(()=>contextTrees.page(treeReader,treeId,nodeId,raw,ownerArchive)),
    },
    materialRead:{
      materialCatalog:args=>fenced(()=>reader.materialCatalog(args)),
      materialRead:args=>fenced(()=>reader.materialRead(args)),
    },
    memoryRead:{
      memory:(ref,scope,ownerArchive)=>fenced(()=>reader.memory(ref,scope,ownerArchive)),
      memoryPage:(args,ownerArchive)=>fenced(()=>reader.memoryPage(args,ownerArchive)),
      memoryAsync:(ref,scope,ownerArchive,snapshot,exposure)=>fenced(()=>reader.memoryAsync(ref,scope,ownerArchive,snapshot,exposure)),
      memoryPageAsync:(args,ownerArchive,snapshot,exposure)=>fenced(()=>reader.memoryPageAsync(args,ownerArchive,snapshot,exposure)),
      assertMemoryReadable:(cards,policy)=>fenced(()=>reader.assertMemoryReadable(cards,policy)),
    },
    memorySnapshots:{
      // A caller may retain this capability before disposal. Check the factory
      // lifecycle at invocation, not only when the property is read.
      get memoryBindings(){
        const bindings=reader.memoryBindings();
        return bindings?{retainSnapshot:(ids?:readonly string[])=>fenced(()=>trackBindingSnapshot(bindings.retainSnapshot(ids)))}:undefined;
      },
      retainMemorySnapshot:context=>fenced(()=>reader.retainMemorySnapshot(context)),
      memorySnapshot:context=>fenced(()=>reader.memorySnapshot(context)),
      releaseMemorySnapshot:context=>fenced(()=>reader.releaseMemorySnapshot(context)),
    },
    memoryInputSelection:{
      memoryPlanSelection:(scope,bindings,policy,evidenceIds,maximum)=>fenced(()=>reader.memoryPlanSelection(scope,bindings,policy,evidenceIds,maximum)),
      memorySelection:(scope,maximum,policy,requirements)=>fenced(()=>reader.memorySelection(scope,maximum,policy,requirements)),
    },
  };
  Object.freeze(ports);
  const assembly=Object.freeze({contextTrees});
  return Object.freeze({
    ports,
    assembly,
    agent(options:EvidenceReaderAgentOptions):ContextReader {
      assertOpen();
      const view=reader.agent(options),guarded={} as ContextReader;
      for(const key of Object.keys(view) as (keyof ContextReader)[]){
        const value=view[key];
        if(typeof value!=='function')continue;
        Object.defineProperty(guarded,key,{enumerable:true,value:(...args:unknown[])=>fenced(()=>(value as (...values:unknown[])=>unknown).apply(view,args))});
      }
      return guarded;
    },
    routes(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Context routes are already installed',409);
      assertOpen();
      mounted.add(app);
      app.register(async child=>{
        child.addHook('onRequest',async(_request,reply)=>{if(disposed||reader.disposed)return reply.code(503).send({error:'feature_unavailable'});});
        deps.mountRoutes(child);
      });
    },
    dispose(){
      if(disposed)return;
      disposed=true;
      for(const snapshot of [...bindingSnapshots]){try{snapshot.release();}catch{}}
      bindingSnapshots.clear();
      reader.dispose();
    },
    get disposed(){return disposed;},
  });
}

/** Private build input for the selected Evidence/context read owner. It lends
 * the fixed reader facade and trusted route producer; it carries no Store or
 * raw reader. */
export interface EvidenceContextReaderInputs extends EvidenceContextReaderDependencies {
  readonly onStarted?:(platform:EvidenceContextReader)=>void;
}
export const evidenceContextReaderInputsContract=serviceContract<EvidenceContextReaderInputs>('mote.central.evidence-context-reader-inputs','1');
export const evidenceContextReaderInputsContribution={
  id:'evidence-context-reader-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service' as const,id:evidenceContextReaderInputsContract.id,apiVersion:evidenceContextReaderInputsContract.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const evidenceContextReaderInputsDeclaration={id:evidenceContextReaderInputsContribution.id,apiVersion:'1'} as const;

/** Selected owner activation: it owns the context registry, read ports, route
 * mounting and lifecycle over the trusted fixed facade/producer. */
export const evidenceContextReaderPlugin:CentralDomainPlugin=Object.freeze<CentralDomainPlugin>({
  contribution:evidenceContextReaderContribution,declaration:evidenceContextReaderDeclaration,replacement:evidenceContextReaderReplacement,
  activation:{featureId:'mote.context',requires:{inputs:{provider:evidenceContextReaderInputsContribution.id,service:evidenceContextReaderInputsContract}},
    async create(context,bindings){
      const input=await context.services.acquire(evidenceContextReaderInputsContract,bindings.inputs!);
      context.scope.defer(()=>input.release());
      const platform=createEvidenceContextReader(input.value);
      context.scope.defer(()=>platform.dispose());
      return {
        route:{id:'mote.context',mount(app){platform.routes(app);}},
        prepare(){},
        start(){
          const {ports}=platform;
          context.provide(evidenceContextReaderContribution.id,centralServices.captureRead,ports.captureRead);
          context.provide(evidenceContextReaderContribution.id,centralServices.captureContextRead,ports.captureContextRead);
          context.provide(evidenceContextReaderContribution.id,centralServices.contextNavigationRead,ports.contextNavigationRead);
          context.provide(evidenceContextReaderContribution.id,centralServices.contextTreesRead,ports.contextTreesRead);
          context.provide(evidenceContextReaderContribution.id,centralServices.materialRead,ports.materialRead);
          context.provide(evidenceContextReaderContribution.id,centralServices.memoryRead,ports.memoryRead);
          context.provide(evidenceContextReaderContribution.id,centralServices.memorySnapshots,ports.memorySnapshots);
          input.value.onStarted?.(platform);
        },
        quiesce(){},stop:async()=>{platform.dispose();},dispose(){platform.dispose();},
      };
    }},
});
