import {executionEnvelopeSchema,canonicalRunStatus,executionEnvelope,type ExecutionEnvelope,type LegacyExecutionInput,type RunStatus} from '@mote/shared/execution';

export type ExecutionProjection={execution:ExecutionEnvelope};

/** Add the canonical projection while preserving every legacy field. */
export function withExecution<T extends object>(value:T,input:LegacyExecutionInput):T&ExecutionProjection {
  return {...value,execution:executionEnvelope(input)};
}

/**
 * Persisted runs from older releases do not have an execution envelope. This
 * accessor normalizes them at the read boundary, so opening an old archive is
 * enough to make it usable; no user content or derived artifact is rewritten.
 */
export function normalizeRun<T extends {status?:string;state?:string}>(value:T):T&ExecutionProjection {
  const stored=executionEnvelopeSchema.safeParse((value as {execution?:unknown}).execution);
  if(stored.success&&stored.data.status===canonicalRunStatus(value)){
    const availableAt=(value as {availableAt?:number}).availableAt,execution=stored.data;
    if(execution.failure&&typeof availableAt==='number'&&Number.isSafeInteger(availableAt))execution.failure.retryAfterMs=Math.max(0,Math.min(7*86400000,availableAt-Date.now()));
    return {...value,execution};
  }
  return withExecution(value,value);
}

export function publicLegacyStatus(status:RunStatus):string {
  switch(status){
    case 'succeeded':return 'completed';
    case 'cancelled':return 'cancelled';
    case 'failed':return 'failed';
    case 'running':return 'running';
    case 'queued':return 'queued';
    case 'retry_wait':return 'retry_wait';
    case 'waiting':return 'waiting';
    case 'skipped':return 'skipped';
  }
}
