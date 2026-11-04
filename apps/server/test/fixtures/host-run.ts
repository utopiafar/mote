import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {TokenUsage} from '@mote/shared';

type HostEvent=Parameters<NonNullable<QueryInput['onHostRunEvent']>>[0];
export type HostTerminal='completed'|'failed'|'cancelled'|'yielded';

const identity=(runId:string):HostEvent['identity']=>({
  runId,
  runtime:{id:'generated-runtime',revision:1,profileId:'generated-profile',profileRevision:1,assemblyFingerprint:'generated-fingerprint'},
  model:{modelId:'generated-model',modelRevision:1,profileId:'generated-profile',profileRevision:1,transport:'generated'},
});

export function hostUsage(input:Pick<QueryInput,'onHostRunEvent'>,usage:TokenUsage,runId=randomUUID()):string{
  input.onHostRunEvent?.({identity:identity(runId),attemptId:'generated-attempt',event:{type:'usage',usage}});
  return runId;
}

export function hostTerminal(input:Pick<QueryInput,'onHostRunEvent'>,kind:HostTerminal='completed',runId=randomUUID()):string{
  input.onHostRunEvent?.({identity:identity(runId),attemptId:'generated-attempt',event:{type:'attempt.terminal',terminal:kind==='failed'?{kind:'failed',reason:'provider_error'}:kind==='cancelled'?{kind:'cancelled',cause:'cancelled'}:kind==='yielded'?{kind:'yielded'}:{kind:'completed'}}});
  input.onHostRunEvent?.({identity:identity(runId),attemptId:'generated-attempt',event:{type:'run.terminal',terminal:kind==='completed'?{kind}
    :kind==='yielded'?{kind}
    :kind==='cancelled'?{kind,cause:'cancelled'}
    :{kind:'failed',failure:{code:'internal'}}}});
  return runId;
}

/** Emit the Host observations a generated leaf would publish for one run. */
export function hostRun(input:Pick<QueryInput,'onHostRunEvent'>,options:{usage?:TokenUsage;terminal?:HostTerminal;runId?:string}={}):string{
  const runId=options.usage?hostUsage(input,options.usage,options.runId):options.runId??randomUUID();
  hostTerminal(input,options.terminal??'completed',runId);
  return runId;
}
