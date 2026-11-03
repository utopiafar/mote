import type {QueryInput} from '@mote/agent';
import type {TokenUsage} from '@mote/shared';
import type {ServerDiagnostics} from './diagnostics.js';
import type {AdmittedUsageMeter} from './plugins/observability-platform.js';

export type HostRunEventObserver=NonNullable<QueryInput['onHostRunEvent']>;
type HostRunEvent=Parameters<HostRunEventObserver>[0];

export interface HostRunUsageObserverOptions {
  /** Bound by trusted assembly to one actual Host run, never prompt/config data. */
  readonly runId:string;
  /** The existing C06 run-level meter. Attempts do not create receipts. */
  readonly meter:AdmittedUsageMeter;
  readonly diagnostics:Pick<ServerDiagnostics,'record'>;
}

const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function normalizedUsage(usage:TokenUsage):TokenUsage|undefined {
  if(!usage||!['requests','reportedRequests','inputTokens','outputTokens','totalTokens'].every(key=>count(usage[key as keyof TokenUsage]))||
    !['cacheReadTokens','cacheWriteTokens','reasoningTokens'].every(key=>usage[key as keyof TokenUsage]===undefined||count(usage[key as keyof TokenUsage]))||
    usage.measurement!==undefined&&usage.measurement!=='thread_cumulative'||usage.complete!==undefined&&typeof usage.complete!=='boolean')return;
  return {requests:usage.requests,reportedRequests:usage.reportedRequests,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:usage.totalTokens,
    ...(usage.cacheReadTokens===undefined?{}:{cacheReadTokens:usage.cacheReadTokens}),...(usage.cacheWriteTokens===undefined?{}:{cacheWriteTokens:usage.cacheWriteTokens}),
    ...(usage.reasoningTokens===undefined?{}:{reasoningTokens:usage.reasoningTokens}),...(usage.measurement===undefined?{}:{measurement:usage.measurement}),
    ...(usage.complete===undefined?{}:{complete:usage.complete})};
}
const isolated=(observe:()=>unknown)=>{try{observe();}catch{/* Telemetry does not own authorization, results or execution failures. */}};

/** One Host run's existing cumulative usage series and terminal observations.
 * This is not a lifecycle, ledger or mode guard. Trusted app assembly must
 * select the Host finalizer explicitly and remove its old wrapper finalizers
 * before connecting this observer; non-Host operations keep their own owner.
 * Observer exceptions cannot be used to enforce that execution contract.
 */
export function createHostRunUsageObserver(options:HostRunUsageObserverOptions):HostRunEventObserver {
  let finalized=false;
  const attemptTerminals=new Set<string>();
  const record=(name:string,envelope:HostRunEvent,kind:string,status?:'completed'|'failed'|'yielded')=>isolated(()=>options.diagnostics.record(name,{
    runId:options.runId,...(envelope.attemptId===null?{}:{attemptId:envelope.attemptId}),...(status?{status}:{}),
    // Use the existing privacy-filtered diagnostic vocabulary, not arbitrary
    // terminal/provider strings or new fields. The full hook retains its type.
    ...(kind==='cancelled'?{category:'cancelled'}:kind==='rejected'||kind==='output_limit'?{category:'agent_response'}:kind==='failed'?{category:'internal'}:
      kind==='invalid_usage'?{category:'validation'}:kind==='run_identity_mismatch'?{category:'conflict'}:{}),
    ...(kind==='output_limit'?{reason:'output_limit'}:{}),
  }));
  return envelope=>{
    if(envelope.identity.runId!==options.runId){record('agent.runtime_event_rejected',envelope,'run_identity_mismatch');return;}
    if(finalized)return;
    const {event}=envelope;
    if(event.type==='usage'){
      const usage=normalizedUsage(event.usage);
      if(!usage){record('agent.runtime_event_rejected',envelope,'invalid_usage');return;}
      // Native adapters already produce cumulative run/thread samples. Replace,
      // never sum or deduplicate by event type: later values in an attempt count.
      isolated(()=>options.meter.update(usage));
    }else if(event.type==='attempt.terminal'){
      if(envelope.attemptId===null||attemptTerminals.has(envelope.attemptId))return;
      attemptTerminals.add(envelope.attemptId);
      record('agent.runtime_attempt_terminal',envelope,event.terminal.kind,event.terminal.kind==='completed'?'completed':event.terminal.kind==='yielded'?'yielded':'failed');
    }else if(event.type==='run.terminal'){
      // A run terminal normally carries its LAST (non-null) attempt id. Only
      // the run is the finalization key, not a particular attempt or its status.
      finalized=true;
      isolated(()=>event.terminal.kind==='completed'||event.terminal.kind==='yielded'?options.meter.complete():options.meter.fail());
      record('agent.runtime_run_terminal',envelope,event.terminal.kind,event.terminal.kind==='completed'?'completed':event.terminal.kind==='yielded'?'yielded':'failed');
    }
  };
}
