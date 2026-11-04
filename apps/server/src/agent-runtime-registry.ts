import {randomUUID} from 'node:crypto';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import type {AsyncLocalStorage} from 'node:async_hooks';
import {AgentNotConfiguredError,AgentYieldError,type AgentOptions,type ContextReader,type QueryInput} from '@mote/agent';
import {DEPLOYMENT_MODEL_PROFILE_ID,type ModelProfile,type ModelSettings} from '@mote/shared/models';
import type {QueryResult} from '@mote/shared';
import type {BackgroundModelAuthorization,ModelConnection} from './background-model-authorization.js';
import type {ConcurrencyGate} from './concurrency.js';
import {moteText} from './i18n.js';
import {createModelAgent,type ModelAgentFactory,type ModelAgentIdentity} from './model-agent.js';
import {createAgentModelHost} from './agent-model-host.js';
import {agentModelConnection} from './model-authorization-host.js';
import type {PreparedModelSettings} from './model-settings.js';
import type {ProviderAdmission} from './provider-admission.js';
import type {QueryAgent,QueryRunLease} from './query-agent.js';
import {StoreError} from './store.js';

export interface AgentRuntimeRegistryDependencies {
  readonly codex:AgentOptions['codex'];
  /** Trusted build adapter only; settings never choose executable code. */
  readonly createModelAgent?:ModelAgentFactory;
  readonly authorization:Pick<BackgroundModelAuthorization,'assertCurrent'>;
  readonly admission:Pick<ProviderAdmission,'check'|'run'>;
  readonly runModelFor:(settings:ModelSettings,connection:ModelConnection)=>NonNullable<AgentOptions['runModel']>;
  readonly authorizeModelRequest:NonNullable<AgentOptions['authorizeModelRequest']>;
  readonly assertPurpose:(input:QueryInput)=>void;
  readonly assertEvidence:(input:QueryInput)=>void;
  readonly assertEvidenceAsync:(input:QueryInput)=>Promise<void>;
  readonly pinEvidence:(input:QueryInput)=>QueryInput;
  readonly agentGate:Pick<ConcurrencyGate,'run'>;
  readonly interactiveGate:Pick<ConcurrencyGate,'run'>;
  readonly modelContext:Pick<AsyncLocalStorage<QueryInput>,'run'>;
  readonly modelOperation:Pick<AsyncLocalStorage<string>,'run'>;
  readonly archiveImagesEnabled:()=>boolean;
  readonly retainSnapshot:(input:QueryInput)=>void;
  readonly releaseSnapshot:(input:QueryInput)=>void;
  readonly agentStarted:()=>void;
  readonly recordTiming:(input:QueryInput,timing:{lane:'interactive'|'background';queueWaitMs:number;durationMs:number;status:'completed'|'failed'|'yielded'})=>void;
}

type Generation = { id:number; agent: QueryAgent; active: number; retired: boolean; closing?: Promise<void> };

/** Safe control projection. Counts and identifiers only; no agent, credential,
 * endpoint or arbitrary error text crosses this boundary. */
export interface AgentRuntimeGenerationStatus {
  readonly closed:boolean;
  readonly configured:boolean;
  readonly generation:number;
  readonly activeRuns:number;
  /** Replaced or unactivated generations that still have to finish closing. */
  readonly retiringGenerations:number;
  readonly releasedGenerations:number;
  readonly preparedGenerations:number;
  readonly closeErrors:number;
  readonly lastCloseError?:{readonly name:string;readonly code?:string};
}

/** One reloadable query generation. A committed setting only changes
 * subsequent requests; accepted requests keep the generation they leased. */
export class ReloadableAgent implements QueryAgent {
  private current?: Generation;
  private readonly generations = new Set<Generation>();
  private readonly candidates = new Set<Generation>();
  private closed = false;
  private closing?: Promise<void>;
  private nextGeneration = 0;
  private activeRuns = 0;
  private releasedGenerations = 0;
  private closeErrors = 0;
  private lastCloseError?: {name:string;code?:string};
  constructor(private readonly onCloseError: (error?:unknown) => void = () => {}) {}
  get isClosed(): boolean { return this.closed; }
  get configured(): boolean { return !this.closed && Boolean(this.current?.agent.configured); }
  configuredFor(id:string):boolean { return !this.closed && Boolean(this.current?.agent.configuredFor?.(id)??this.current?.agent.configured); }

  /** Actual runtime state for owner control; it never exposes the agent object. */
  status(): AgentRuntimeGenerationStatus {
    return Object.freeze({closed:this.closed,configured:this.configured,generation:this.current?.id??0,activeRuns:this.activeRuns,
      retiringGenerations:this.retiringCount(),releasedGenerations:this.releasedGenerations,preparedGenerations:this.candidates.size,
      closeErrors:this.closeErrors,...(this.lastCloseError?{lastCloseError:{...this.lastCloseError}}:{})});
  }

  async prepare(agent: QueryAgent, activateConfig: () => void, rollbackConfig: () => void = () => {}): Promise<PreparedModelSettings> {
    if (this.closed) { await agent.close(); throw new Error('Agent is closed'); }
    const generation: Generation = { id:++this.nextGeneration, agent, active: 0, retired: false };
    this.candidates.add(generation);
    let activated = false,completed=false,rolledBack=false;
    let previous:Generation|undefined;
    return {
      activate: () => {
        if (activated) return;
        activated = true;
        this.candidates.delete(generation);
        previous = this.current;
        this.generations.add(generation); this.current = generation; activateConfig();
      },
      rollback:()=>{
        if(!activated||completed||rolledBack)return;
        rolledBack=true;this.current=previous;
        try{rollbackConfig();}
        finally{
          // A rollback callback failure must not leak the candidate generation
          // or leave the new generation serving requests.
          generation.retired=true;
          if(!generation.active)void this.retire(generation);
        }
      },
      complete:()=>{
        if(!activated||completed||rolledBack)return;
        completed=true;
        if(previous){previous.retired=true;if(!previous.active)void this.retire(previous);}
      },
      dispose: async () => {
        if (activated) return;
        this.candidates.delete(generation);
        await this.retire(generation);
      },
    };
  }

  async query(args: Parameters<QueryAgent['query']>[0], lease?: Parameters<NonNullable<QueryAgent['query']>>[1]) {
    const generation = this.current;
    if (this.closed) throw new Error('Agent is closed');
    if (!generation) throw new AgentNotConfiguredError();
    generation.active++;this.activeRuns++;
    try { return await generation.agent.query(args, lease); }
    finally { generation.active--;this.activeRuns--; if (generation.retired && !generation.active) void this.retire(generation); }
  }

  private retiringCount():number {
    let count=0;
    for(const generation of new Set([...this.generations,...this.candidates]))if(generation.retired||generation.closing)count++;
    return count;
  }

  /** Release a candidate or a retired generation exactly once. */
  private retire(generation: Generation): Promise<void> {
    if(generation.closing)return generation.closing;
    generation.closing = Promise.resolve().then(() => generation.agent.close())
      .catch(error => {
        this.closeErrors++;
        const value=error as {name?:unknown;code?:unknown}|undefined;
        this.lastCloseError={...(typeof value?.name==='string'?{name:value.name}:{name:'Error'}),...(typeof value?.code==='string'?{code:value.code}:{})};
        this.onCloseError(error);
      })
      .finally(() => { this.generations.delete(generation);this.candidates.delete(generation);this.releasedGenerations++; });
    return generation.closing;
  }

  close(): Promise<void> {
    return this.closing ??= (async()=>{
      this.closed = true;
      await Promise.all([...new Set([...this.candidates,...this.generations])].map(generation => this.retire(generation)));
    })();
  }
}

export interface AgentRuntimeRegistryStatus extends AgentRuntimeGenerationStatus {
  readonly preparedAgents:number;
  readonly pendingPreparations:number;
  readonly pendingCleanupFailures:number;
  readonly shuttingDown:boolean;
}

/** The single owner of the Agent runtime generation: it builds wrapped
 * per-profile adapters, tracks prepared and retired model registries, and
 * drains every created adapter on close. A05 owns actual runtime services and
 * Host output; C04 remains the sole model admission/disclosure authority. */
export class AgentRuntimeRegistry extends ReloadableAgent {
  private shuttingDown=false;
  private preparationTurn=Promise.resolve();
  private readonly agents=new Set<QueryAgent>();
  private readonly preparing=new Set<Promise<QueryAgent>>();
  private readonly lateCleanupErrors:unknown[]=[];
  private closeTask?:Promise<void>;
  constructor(private readonly dependencies:AgentRuntimeRegistryDependencies,onCloseError?:(error?:unknown)=>void){super(onCloseError);}

  private assertOpen(){if(this.shuttingDown||this.isClosed)throw new StoreError('Agent runtime registry is closed',503);}

  status():AgentRuntimeRegistryStatus {
    return Object.freeze({...super.status(),preparedAgents:this.agents.size,pendingPreparations:this.preparing.size,
      pendingCleanupFailures:this.lateCleanupErrors.length,shuttingDown:this.shuttingDown});
  }

  readonly factory:ModelAgentFactory=(settings,reader,_hooks,identity)=>{
    this.assertOpen();
    if(!identity)throw new StoreError('Model host identity is missing',409);
    const pending=this.create(settings,reader,identity);
    this.preparing.add(pending);
    void pending.then(()=>this.preparing.delete(pending),()=>this.preparing.delete(pending));
    return pending;
  };

  private async create(settings:ModelSettings,reader:ContextReader,identity:ModelAgentIdentity){
    const d=this.dependencies,connection=agentModelConnection(identity,settings);
    const host=createAgentModelHost(settings,connection,d);
    const inner=await (d.createModelAgent?d.createModelAgent(settings,reader,host,identity):createModelAgent(settings,reader,d.codex,host.runModel,host.authorizeModelRequest));
    if(this.shuttingDown||this.isClosed){
      const primary=new StoreError('Agent runtime registry is closed',503);
      try{await inner.close();}catch(cleanup){this.lateCleanupErrors.push(cleanup);throw new AggregateError([primary,cleanup],'Agent startup was stopped and cleanup failed',{cause:primary});}
      throw primary;
    }
    return this.wrap(inner,settings,identity);
  }

  wrap(inner:QueryAgent,settings:ModelSettings,identity:ModelAgentIdentity):QueryAgent {
    this.assertOpen();
    const d=this.dependencies,thisRegistry=this;
    let closing:Promise<void>|undefined;
    const stop=new AbortController(),pending=new Set<Promise<QueryResult>>();
    const assertOpen=()=>{this.assertOpen();if(closing)throw new StoreError('Agent runtime adapter is closed',503);};
    const wrapped:QueryAgent={
      get configured(){return !closing&&!thisRegistry.isClosed&&inner.configured;},
      ...(inner.configuredFor?{configuredFor:(id:string)=>!closing&&!thisRegistry.isClosed&&inner.configuredFor!(id)}:{}),
      close:()=>{
        if(!closing){
          stop.abort(new StoreError('Agent runtime adapter is closed',503));
          closing=(async()=>{
            try{await inner.close();}finally{await Promise.allSettled([...pending]);this.agents.delete(wrapped);}
          })();
        }
        return closing;
      },
      query:(input,lease)=>{
        const task=execute(input,lease);pending.add(task);
        void task.then(()=>pending.delete(task),()=>pending.delete(task));
        return task;
      },
    };
    const execute=async(input:QueryInput,lease?:QueryRunLease):Promise<QueryResult>=>{
        assertOpen();if(!inner.configured)throw new AgentNotConfiguredError();
        const connection=agentModelConnection(identity,settings);d.authorization.assertCurrent(connection);
        d.assertPurpose(input);await d.assertEvidenceAsync(input);assertOpen();
        input=d.pinEvidence(input);input.signal?.throwIfAborted();d.admission.check(settings);
        input.onProgress?.({stage:'starting',phase:'started',message:moteText('等待 Agent 执行名额')});
        const queuedAt=performance.now(),lane=input.executionLane==='interactive'?'interactive':'background';
        return (lane==='interactive'?d.interactiveGate:d.agentGate).run(async()=>{
          const turn=this.preparationTurn.then(()=>yieldEventLoop());this.preparationTurn=turn.catch(()=>{});
          await turn;assertOpen();input.signal?.throwIfAborted();
          // Keep the live request identity: fresh disclosure extends its pins.
          input.archiveImagesEnabled=d.archiveImagesEnabled();
          const operationId=input.traceContext?.operationId??(input.traceContext?.jobId?'job:'+input.traceContext.jobId:'query:'+randomUUID());
          const admittedAt=performance.now(),queueWaitMs=admittedAt-queuedAt;let status:'completed'|'failed'|'yielded'='failed';
          try{
            d.retainSnapshot(input);
            const result=await d.modelOperation.run(operationId,()=>d.admission.run(settings,()=>{
              assertOpen();d.authorization.assertCurrent(connection);d.assertEvidence(input);d.agentStarted();
              return d.modelContext.run(input,()=>inner.query(input,lease));
            }));
            assertOpen();d.authorization.assertCurrent(connection);status='completed';return result;
          }catch(error){if(error instanceof AgentYieldError)status='yielded';throw error;}
          finally{d.releaseSnapshot(input);d.recordTiming(input,{lane,queueWaitMs,durationMs:performance.now()-admittedAt,status});}
        },input.signal?AbortSignal.any([input.signal,stop.signal]):stop.signal,input.traceContext?.operationId);
    };
    this.agents.add(wrapped);return wrapped;
  }

  /** Build one immutable profile registry and adopt it as a prepared model
   * generation. Failure closes every adapter built for the rejected candidate. */
  async prepareModels(
    profiles:ModelProfile[],
    reader:ContextReader,
    options:{defaultProfileId?:string;initialAgent?:QueryAgent;activate:()=>void;rollback?:()=>void},
  ):Promise<PreparedModelSettings>{
    this.assertOpen();
    const candidate=await this.createModelRegistry(profiles,reader,options.initialAgent,options.defaultProfileId??DEPLOYMENT_MODEL_PROFILE_ID);
    try{return await super.prepare(candidate,options.activate,options.rollback);}
    catch(error){await candidate.close().catch(()=>{});throw error;}
  }

  private async createModelRegistry(profiles:ModelProfile[],reader:ContextReader,initial:QueryAgent|undefined,defaultProfileId:string):Promise<QueryAgent>{
    const agents=new Map<string,QueryAgent>(),create=this.factory;
    try {
      for(const profile of profiles)agents.set(profile.id,profile.id===defaultProfileId&&initial?initial:await create(profile.settings,reader,undefined,{kind:'profile',id:profile.id}));
    } catch(error) {await Promise.allSettled([...agents.values()].map(agent=>agent.close()));throw error;}
    return {
      configured:[...agents.values()].some(agent=>agent.configured),
      configuredFor:id=>Boolean(agents.get(id)?.configured),
      async query(input,lease){
        const id=input.modelProfileId??defaultProfileId,agent=agents.get(id),profile=profiles.find(p=>p.id===id);
        if(!agent||!profile||!agent.configured)throw new AgentNotConfiguredError();
        const {modelProfileId:_,modelOverride,...request}=input;
        const model=modelOverride??profile.settings.model;
        const temporary=model!==profile.settings.model?await create({...profile.settings,model},reader,undefined,{kind:'profile',id:profile.id}):undefined;
        try {
          const result=await (temporary??agent).query(request,lease);
          return {...result,modelSelection:{profileId:id,profileName:profile.name,provider:profile.settings.provider,model}};
        } finally {await temporary?.close();}
      },
      async close(){const results=await Promise.allSettled([...agents.values()].map(agent=>agent.close()));if(results.some(r=>r.status==='rejected'))throw new Error('Model registry cleanup failed');},
    };
  }

  close():Promise<void>{
    return this.closeTask??=(async()=>{
      this.shuttingDown=true;
      const draining=Promise.allSettled([...this.agents].map(agent=>agent.close()));
      // A factory resolving after shutdown closes its unpublished candidate.
      await Promise.allSettled([...this.preparing]);
      await super.close();
      const errors=[...(await draining).flatMap(result=>result.status==='rejected'?[result.reason]:[]),...this.lateCleanupErrors];
      if(errors.length)throw new AggregateError(errors,'Agent runtime registry cleanup failed');
    })();
  }
}
