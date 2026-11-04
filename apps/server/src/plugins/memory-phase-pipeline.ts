import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {MemoryPipeline,type MemoryPhasePorts,type MemoryPipelineOptions} from '../memory-pipeline.js';
import {reviewMemory,type MemoryDraftOrigin} from '../memory-review.js';
import {MemoryReviewCache} from '../memory-review-cache.js';
import type {MemoryDeletions} from '../memory-deletions.js';
import type {MemoryReviewStrategy} from '../memory-strategy-contract.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';

/** C22A owns the durable extraction/review phases and the bounded independent
 * review cache. The pipeline is the only writer of phase checkpoints; review
 * is a separate read-only model pass whose verdict the pipeline passes to
 * publication with the exact range, required pins and configuration. */
export const memoryPhasePipelineContribution={
  id:'memory-phase-pipeline',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'service',id:centralServices.memoryStrategies.id,version:'1.0.0'},
    {kind:'service',id:centralServices.memoryBindingControl.id,version:'1.0.0'},
    {kind:'service',id:centralServices.memoryProviderAdapters.id,version:'1.0.0'},
    {kind:'service',id:centralServices.memoryStagePublication.id,version:'1.0.0'},
  ],
  provides:[{kind:'service' as const,id:centralServices.memoryPhase.id,apiVersion:centralServices.memoryPhase.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const memoryPhasePipelineDeclaration={id:memoryPhasePipelineContribution.id,apiVersion:'1'} as const;
/** Jobs, phase checkpoints, native cleanup intents and publication outcomes stay
 * durable in the vault, so a fresh activation resumes accepted work. */
export const memoryPhasePipelineReplacement='hot' as const;

export type MemoryPhasePipelineOptions=Omit<MemoryPipelineOptions,'phases'>&{readonly phases:Omit<MemoryPhasePorts,'review'>};
export interface MemoryPhaseReviewDependencies {
  readonly query:(input:QueryInput)=>Promise<QueryResult>;
  readonly deletions?:MemoryDeletions;
  readonly authorizeDeletionEvidence?:(input:QueryInput,ids:string[])=>void;
  /** Exact current original/model snapshot for bounded verdict reuse. */
  readonly snapshot?:(input:QueryInput,result:QueryResult)=>string;
  readonly taskInstructions?:string;
}
export interface MemoryPhasePipelineDependencies {
  readonly pipeline:MemoryPhasePipelineOptions;
  readonly review:MemoryPhaseReviewDependencies;
}
export type MemoryPhaseReview=(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy,draftOrigin?:MemoryDraftOrigin)=>Promise<QueryResult>;
export interface MemoryPhasePipelineBindings { readonly phase:ServiceBinding }
export interface MemoryPhasePipelinePort {
  readonly pipeline:MemoryPipeline;
  /** New independent reviews are admitted only while active. An accepted run
   * keeps its phase closure until quiesce/stop drains or fences it. */
  readonly review:MemoryPhaseReview;
}
export interface MemoryPhasePipelinePlatform extends PluginLifecycle {
  readonly port:MemoryPhasePipelinePort;
  readonly pipeline:MemoryPipeline;
  readonly reviews:MemoryReviewCache;
  review:MemoryPhaseReview;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Memory phase pipeline is unavailable',503);

/** Prepare constructs the phase pipeline and its process-local review cache;
 * start admits jobs and new reviews; quiesce refuses new work while accepted
 * runs drain; stop drains/cancels the owned pipeline, clears the cache and
 * leaves durable native cleanup and phase checkpoints recoverable. */
export function createMemoryPhasePipeline(dependencies:MemoryPhasePipelineDependencies):MemoryPhasePipelinePlatform {
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let pipeline:MemoryPipeline|undefined,reviews:MemoryReviewCache|undefined,closing:Promise<void>|undefined;
  const readable=()=>{
    if(!pipeline||!reviews||phase==='created'||phase==='stopped')throw unavailable();
    return {pipeline,reviews};
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return readable();
  };
  const runReview:MemoryPhaseReview=(input,result,strategy,draftOrigin)=>{
    const {reviews:pipelineReviews}=readable();
    return reviewMemory(input,result,dependencies.review.query,{
      draftOrigin,strategy,deletions:dependencies.review.deletions,
      authorizeDeletionEvidence:ids=>dependencies.review.authorizeDeletionEvidence?.(input,ids),
      cache:pipelineReviews,snapshot:dependencies.review.snapshot?()=>dependencies.review.snapshot!(input,result):undefined,
      taskInstructions:dependencies.review.taskInstructions,
    });
  };
  const review:MemoryPhasePipelinePort['review']=async(input,result,strategy,draftOrigin)=>{
    active();
    return runReview(input,result,strategy,draftOrigin);
  };
  const close=()=>closing??=(async()=>{
    const owned=pipeline;
    phase='stopped';
    pipeline=undefined;
    reviews?.clear();reviews=undefined;
    if(owned)await owned.close();
  })().finally(()=>{closing=undefined;});
  const port:MemoryPhasePipelinePort=Object.freeze({get pipeline(){return readable().pipeline;},review});
  const platform:MemoryPhasePipelinePlatform=Object.freeze({
    port,
    get pipeline(){return readable().pipeline;},
    get reviews(){return readable().reviews;},
    review,
    prepare(){
      if(phase!=='created'&&phase!=='stopped')throw unavailable();
      phase='preparing';
      try{
        const cache=new MemoryReviewCache();
        const owned=new MemoryPipeline({...dependencies.pipeline,phases:{...dependencies.pipeline.phases,review:runReview}});
        reviews=cache;pipeline=owned;
        phase='prepared';
      }catch(error){
        reviews?.clear();reviews=undefined;pipeline=undefined;phase='stopped';
        throw error;
      }
    },
    start(){
      if(phase!=='prepared'&&phase!=='quiescing')throw unavailable();
      pipeline!.start();
      phase='active';
    },
    quiesce(_reason?:StopReason){
      if(phase!=='active')return;
      phase='quiescing';
      pipeline?.quiesce();
    },
    async stop(_reason?:StopReason){await close();},
    dispose:close,close,
  });
  return platform;
}
export type MemoryPhasePipeline=ReturnType<typeof createMemoryPhasePipeline>;

export function createMemoryPhasePipelineFactory(platform:MemoryPhasePipelinePlatform,onStarted?:(bindings:MemoryPhasePipelineBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:()=>platform.prepare(),
      start(){
        platform.start();
        const bindings={phase:context.provide(memoryPhasePipelineContribution.id,centralServices.memoryPhase,platform.port)};
        onStarted?.(bindings);
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
