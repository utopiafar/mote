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
import type {OwnerQuestions} from '../owner-questions.js';
import type {MaterialStore} from '../materials.js';
import {installMemoryOwnerQuestions} from '../memory-owner-questions.js';
import {registerMemoryDelegation,type MemoryDelegationOptions} from '../memory-delegation.js';
import type {MemoryOwnerContinuationPort,MemoryOwnerWorkView} from '../memory-owner-continuation.js';
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
  /** The shared owner-question ledger is read through its current pre-ACV03
   * interface. Declarations remain a Material concern. */
  readonly ownerQuestions?:OwnerQuestions;
  readonly materials?:MaterialStore;
}
export type MemoryPhaseReview=(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy,draftOrigin?:MemoryDraftOrigin)=>Promise<QueryResult>;
export type MemoryPhaseDelegationDependencies=Omit<MemoryDelegationOptions,'pipeline'>;
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
  readonly ownerContinuations:MemoryOwnerContinuationPort;
  review:MemoryPhaseReview;
  /** Delegation is registered by this scope once its coordinator runtime
   * exists; product jobs stay owned by the same phase pipeline. */
  attachDelegation(dependencies:MemoryPhaseDelegationDependencies):void;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Memory phase pipeline is unavailable',503);

/** The owner-question provider's only continuation capability. It reads and
 * writes the phase pipeline's durable job/range state but cannot admit work,
 * retry, call a model or publish. */
export function createMemoryOwnerContinuations(pipeline:MemoryPipeline):MemoryOwnerContinuationPort {
  const view=(id:string):MemoryOwnerWorkView=>{
    const job=pipeline.get(id);
    return {id:job.id,status:job.status,batches:job.batches.map(({id,evidenceRanges})=>({id,evidenceRanges}))};
  };
  const continuations:MemoryOwnerContinuationPort={
    read:view,
    scope:(jobId,batchId,key)=>{
      const {job,member,strategy}=pipeline.ownerQuestionScope(jobId,batchId,key),{id,modelProfileId,modelOverride,recipes,contextTime,timeZone,batchCharacters}=job;
      return {job:{id,modelProfileId,modelOverride,recipes,contextTime,timeZone,batchCharacters},member,strategy};
    },
    assertCurrent:(jobId,ref,ids)=>pipeline.assertOwnerContinuationCurrent(jobId,ref,ids),
    create:input=>view(pipeline.create(input).id),
    link:(jobId,batchId,continuation,key)=>pipeline.continuedOwnerQuestion(jobId,batchId,continuation,key),
    closeGap:(jobId,batchId,key)=>pipeline.closeOwnerQuestion(jobId,batchId,key),
    dependencies:ids=>pipeline.evidenceDependencies(ids),
    setQuestions:handler=>pipeline.setOwnerQuestionHandler(handler),
  };
  return Object.freeze(continuations);
}

/** Prepare constructs the phase pipeline, its process-local review cache and
 * the owner-continuation port. Start admits jobs, new reviews and the shared
 * owner-question provider; quiesce withdraws that provider before refusing new
 * work while accepted runs drain; stop closes the attached delegation scope,
 * drains/cancels the owned pipeline and leaves durable native cleanup and phase
 * checkpoints recoverable. */
export function createMemoryPhasePipeline(dependencies:MemoryPhasePipelineDependencies):MemoryPhasePipelinePlatform {
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let pipeline:MemoryPipeline|undefined,reviews:MemoryReviewCache|undefined,continuations:MemoryOwnerContinuationPort|undefined,closing:Promise<void>|undefined;
  let disposeQuestions:(()=>void)|undefined,delegation:ReturnType<typeof registerMemoryDelegation>|undefined,delegationDependencies:MemoryPhaseDelegationDependencies|undefined;
  const readable=()=>{
    if(!pipeline||!reviews||!continuations||phase==='created'||phase==='stopped')throw unavailable();
    return {pipeline,reviews,continuations};
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
  const registerDelegation=()=>{
    if(delegation||!delegationDependencies||phase!=='active'||!pipeline)return;
    delegation=registerMemoryDelegation({...delegationDependencies,pipeline});
  };
  const close=()=>closing??=(async()=>{
    const owned=pipeline,stoppingDelegation=delegation,withdrawQuestions=disposeQuestions;
    const errors:unknown[]=[];
    phase='stopped';
    pipeline=undefined;continuations=undefined;disposeQuestions=undefined;delegation=undefined;delegationDependencies=undefined;
    reviews?.clear();reviews=undefined;
    try{withdrawQuestions?.();}catch(error){errors.push(error);}
    if(stoppingDelegation)try{await stoppingDelegation.close();}catch(error){errors.push(error);}
    if(owned)try{await owned.close();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Memory phase pipeline disposal failed');
  })().finally(()=>{closing=undefined;});
  const port:MemoryPhasePipelinePort=Object.freeze({get pipeline(){return readable().pipeline;},review});
  const platform:MemoryPhasePipelinePlatform=Object.freeze({
    port,
    get pipeline(){return readable().pipeline;},
    get reviews(){return readable().reviews;},
    get ownerContinuations(){return readable().continuations;},
    review,
    attachDelegation(value:MemoryPhaseDelegationDependencies){
      if(delegationDependencies||delegation)throw unavailable();
      delegationDependencies=value;
      try{registerDelegation();}catch(error){delegationDependencies=undefined;throw error;}
    },
    prepare(){
      if(phase!=='created'&&phase!=='stopped')throw unavailable();
      phase='preparing';
      try{
        const cache=new MemoryReviewCache();
        const owned=new MemoryPipeline({...dependencies.pipeline,phases:{...dependencies.pipeline.phases,review:runReview}});
        reviews=cache;pipeline=owned;continuations=createMemoryOwnerContinuations(owned);
        phase='prepared';
      }catch(error){
        reviews?.clear();reviews=undefined;pipeline=undefined;continuations=undefined;phase='stopped';
        throw error;
      }
    },
    start(){
      if(phase!=='prepared'&&phase!=='quiescing')throw unavailable();
      const owned=readable().pipeline,current=readable().continuations;
      owned.start();
      try{
        if(dependencies.ownerQuestions&&dependencies.materials)disposeQuestions=installMemoryOwnerQuestions({
          questions:dependencies.ownerQuestions,continuations:current,
          materials:dependencies.materials,store:dependencies.pipeline.store,query:dependencies.review.query,
        });
        phase='active';
        registerDelegation();
      }catch(error){
        phase='quiescing';
        disposeQuestions?.();disposeQuestions=undefined;
        owned.quiesce();
        throw error;
      }
    },
    quiesce(_reason?:StopReason){
      if(phase!=='active')return;
      phase='quiescing';
      // A withdrawn provider rejects a late reply before it can create a
      // continuation; the accepted pipeline work keeps draining.
      disposeQuestions?.();disposeQuestions=undefined;
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
