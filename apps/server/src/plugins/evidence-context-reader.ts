import type {ManifestContribution} from '@mote/plugin-api';
import type {ContextReader} from '@mote/agent';
import type {FastifyInstance} from 'fastify';
import {StoreError} from '../store.js';
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
