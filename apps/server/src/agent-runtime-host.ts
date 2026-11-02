import {randomUUID} from 'node:crypto';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import type {AsyncLocalStorage} from 'node:async_hooks';
import {AgentNotConfiguredError,AgentYieldError,type AgentOptions,type ContextReader,type QueryInput} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import type {QueryResult} from '@mote/shared';
import type {BackgroundModelAuthorization,ModelConnection} from './background-model-authorization.js';
import type {ConcurrencyGate} from './concurrency.js';
import {moteText} from './i18n.js';
import {createModelAgent,type ModelAgentFactory,type ModelAgentIdentity} from './model-agent.js';
import {agentModelConnection} from './model-authorization-host.js';
import type {ProviderAdmission} from './provider-admission.js';
import type {QueryAgent} from './query-agent.js';
import {StoreError} from './store.js';

export interface AgentRuntimeHostDependencies {
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

/** Fixed trusted Central assembly. A05 owns actual runtime services and Host
 * output; C04 remains the sole model admission/disclosure authority. This host
 * owns adapters, not settings generations or a second evidence ledger. */
export class AgentRuntimeHost {
  private closed=false;
  private closing?:Promise<void>;
  private preparationTurn=Promise.resolve();
  private readonly agents=new Set<QueryAgent>();
  private readonly preparing=new Set<Promise<QueryAgent>>();
  private readonly lateCleanupErrors:unknown[]=[];
  constructor(private readonly dependencies:AgentRuntimeHostDependencies){}

  private assertOpen(){if(this.closed)throw new StoreError('Agent runtime host is closed',503);}

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
    const host={runModel:d.runModelFor(settings,connection),authorizeModelRequest:()=>{d.authorization.assertCurrent(connection);return d.authorizeModelRequest();}};
    const inner=await (d.createModelAgent?d.createModelAgent(settings,reader,host,identity):createModelAgent(settings,reader,d.codex,host.runModel,host.authorizeModelRequest));
    if(this.closed){
      const primary=new StoreError('Agent runtime host is closed',503);
      try{await inner.close();}catch(cleanup){this.lateCleanupErrors.push(cleanup);throw new AggregateError([primary,cleanup],'Agent startup was stopped and cleanup failed',{cause:primary});}
      throw primary;
    }
    return this.wrap(inner,settings,identity);
  }

  wrap(inner:QueryAgent,settings:ModelSettings,identity:ModelAgentIdentity):QueryAgent {
    this.assertOpen();
    const d=this.dependencies,thisHost=this;
    let closing:Promise<void>|undefined;
    const stop=new AbortController(),pending=new Set<Promise<QueryResult>>();
    const assertOpen=()=>{this.assertOpen();if(closing)throw new StoreError('Agent runtime adapter is closed',503);};
    const wrapped:QueryAgent={
      get configured(){return !closing&&!thisHost.closed&&inner.configured;},
      ...(inner.configuredFor?{configuredFor:(id:string)=>!closing&&!this.closed&&inner.configuredFor!(id)}:{}),
      close:()=>{
        if(!closing){
          stop.abort(new StoreError('Agent runtime adapter is closed',503));
          closing=(async()=>{
            try{await inner.close();}finally{await Promise.allSettled([...pending]);this.agents.delete(wrapped);}
          })();
        }
        return closing;
      },
      query:input=>{
        const task=execute(input);pending.add(task);
        void task.then(()=>pending.delete(task),()=>pending.delete(task));
        return task;
      },
    };
    const execute=async(input:QueryInput):Promise<QueryResult>=>{
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
              return d.modelContext.run(input,()=>inner.query(input));
            }));
            assertOpen();d.authorization.assertCurrent(connection);status='completed';return result;
          }catch(error){if(error instanceof AgentYieldError)status='yielded';throw error;}
          finally{d.releaseSnapshot(input);d.recordTiming(input,{lane,queueWaitMs,durationMs:performance.now()-admittedAt,status});}
        },input.signal?AbortSignal.any([input.signal,stop.signal]):stop.signal,input.traceContext?.operationId);
    };
    this.agents.add(wrapped);return wrapped;
  }

  close():Promise<void>{
    this.closed=true;
    return this.closing??=(async()=>{
      const draining=Promise.allSettled([...this.agents].map(agent=>agent.close()));
      // A factory resolving after shutdown closes its unpublished candidate.
      await Promise.allSettled([...this.preparing]);
      const errors=[...(await draining).flatMap(result=>result.status==='rejected'?[result.reason]:[]),...this.lateCleanupErrors];
      if(errors.length)throw new AggregateError(errors,'Agent runtime host cleanup failed');
    })();
  }
}
