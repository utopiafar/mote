import {z} from 'zod';

/**
 * The durable execution vocabulary shared by the server and all clients.
 *
 * The existing domain-specific `status`/`state` fields remain part of the
 * wire contract for older clients.  New code should consume `execution` and
 * use the legacy field only as a compatibility projection.
 */
export const runStatusSchema=z.enum(['waiting','queued','running','retry_wait','succeeded','failed','cancelled','skipped']);
export type RunStatus=z.infer<typeof runStatusSchema>;
export const failureRecoverySchema=z.enum(['auto_retry','needs_action','permanent']);
export type FailureRecovery=z.infer<typeof failureRecoverySchema>;
export const failureScopeSchema=z.enum(['item','provider','system']);
export type FailureScope=z.infer<typeof failureScopeSchema>;
export const waitReasonSchema=z.enum(['dependency','provider_unavailable','user_confirmation','resource_limit','worker_offline','configuration']);
export type WaitReason=z.infer<typeof waitReasonSchema>;
export const executionActionSchema=z.enum(['continue','retry','reprocess','cancel']);
export type ExecutionAction=z.infer<typeof executionActionSchema>;

export const taskFailureSchema=z.object({
  code:z.string().min(1).max(100),
  recovery:failureRecoverySchema,
  scope:failureScopeSchema,
  retryAfterMs:z.number().int().nonnegative().max(7*24*60*60*1000).optional(),
  safeMessage:z.string().min(1).max(1000),
}).strict();
export type TaskFailure=z.infer<typeof taskFailureSchema>;

export const waitConditionSchema=z.object({
  reason:waitReasonSchema,
  resource:z.string().max(200).optional(),
  requiredAction:z.string().max(200).optional(),
  retryAfterMs:z.number().int().nonnegative().max(7*24*60*60*1000).optional(),
}).strict();
export type WaitCondition=z.infer<typeof waitConditionSchema>;

export const retryPolicySchema=z.object({
  maxAttempts:z.number().int().min(1).max(100),
  maxDurationMs:z.number().int().positive().max(7*24*60*60*1000),
  maxRecoveryWindowMs:z.number().int().positive().max(30*24*60*60*1000),
  baseDelayMs:z.number().int().nonnegative().max(24*60*60*1000),
  maxDelayMs:z.number().int().nonnegative().max(7*24*60*60*1000),
  jitterRatio:z.number().min(0).max(1),
}).strict();
export type RetryPolicy=z.infer<typeof retryPolicySchema>;

export const standardRetryPolicy:RetryPolicy={
  maxAttempts:3,maxDurationMs:10*60*1000,maxRecoveryWindowMs:6*60*60*1000,
  baseDelayMs:30_000,maxDelayMs:60*60*1000,jitterRatio:.2,
};

export const executionEnvelopeSchema=z.object({
  status:runStatusSchema,
  attempts:z.number().int().nonnegative(),
  maxAttempts:z.number().int().positive().optional(),
  failure:taskFailureSchema.optional(),
  waiting:waitConditionSchema.optional(),
  allowedActions:z.array(executionActionSchema),
  inputVersion:z.string().max(200).optional(),
  definitionVersion:z.string().max(200).optional(),
  updatedAt:z.string().max(64).optional(),
}).strict();
export type ExecutionEnvelope=z.infer<typeof executionEnvelopeSchema>;

export type LegacyExecutionInput={
  status?:unknown;
  state?:unknown;
  summaryState?:unknown;
  attempts?:unknown;
  maxAttempts?:unknown;
  errorCode?:unknown;
  error?:unknown;
  availableAt?:unknown;
  inputVersion?:unknown;
  definitionVersion?:unknown;
  updatedAt?:unknown;
};

const stringValue=(value:unknown)=>typeof value==='string'&&value.length<=100?value:undefined;
const numberValue=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;

/** Map persisted pre-protocol state without inspecting user content. */
export function canonicalRunStatus(input:LegacyExecutionInput):RunStatus {
  const value=stringValue(input.status??input.state)??'';
  switch(value){
    case 'waiting_for_model': case 'waiting_for_confirmation': case 'blocked': case 'waiting': return 'waiting';
    case 'pending': case 'queued': return 'queued';
    case 'running': return 'running';
    case 'retry_wait': return 'retry_wait';
    case 'completed': case 'succeeded': return 'succeeded';
    case 'cancelled': case 'canceled': return 'cancelled';
    case 'skipped': case 'invalidated': return 'skipped';
    case 'failed': return 'failed';
    case 'interrupted': return 'queued';
    default: return value ? 'waiting' : 'queued';
  }
}

function failureFor(input:LegacyExecutionInput,status:RunStatus):TaskFailure|undefined {
  const code=stringValue(input.errorCode)??(typeof input.error==='object'&&input.error&&'code' in input?stringValue((input.error as {code?:unknown}).code):undefined);
  if(!code)return undefined;
  const retryable=new Set(['provider_failed','model_failed','agent_response','timeout','network','rate_limited','worker_interrupted']);
  const waiting=new Set(['model_unconfigured','provider_unavailable','daily_budget','worker_offline','awaiting_confirmation']);
  const recovery:FailureRecovery=waiting.has(code)?'needs_action':retryable.has(code)?'auto_retry':'permanent';
  const scope:FailureScope=waiting.has(code)&&code!=='daily_budget'?'provider':code==='worker_offline'?'system':'item';
  const safeMessage=code==='model_unconfigured'?'Model configuration is required before this step can continue.':
    code==='daily_budget'?'The configured processing budget is exhausted for now.':
    code==='provider_unavailable'?'The configured provider is unavailable.':
    code==='worker_offline'?'The required worker is offline.':
    code==='evidence_changed'?'The input version changed before this result could be published.':
    'The step did not complete.';
  return taskFailureSchema.parse({code,recovery,scope,...(numberValue(input.availableAt)?{retryAfterMs:Math.max(0,numberValue(input.availableAt)!-Date.now())}:{}),safeMessage});
}

function waitFor(input:LegacyExecutionInput,status:RunStatus,failure?:TaskFailure):WaitCondition|undefined {
  if(status!=='waiting')return undefined;
  const code=failure?.code??stringValue(input.errorCode);
  const reason:WaitReason=code==='model_unconfigured'||code==='provider_unavailable'?'provider_unavailable':
    code==='daily_budget'?'resource_limit':code==='awaiting_confirmation'?'user_confirmation':code==='worker_offline'?'worker_offline':
    code==='dependency'?'dependency':code==='configuration'?'configuration':'dependency';
  return {reason,...(failure?.scope==='provider'?{resource:'configured-provider'}:{}),...(failure?.retryAfterMs!==undefined?{retryAfterMs:failure.retryAfterMs}:{}),...(reason==='provider_unavailable'?{requiredAction:'update_configuration'}:{})};
}

function actions(status:RunStatus, failure?:TaskFailure):ExecutionAction[] {
  if(status==='running'||status==='queued'||status==='retry_wait')return ['cancel'];
  if(status==='waiting')return ['continue','cancel'];
  if(status==='failed')return failure?.recovery==='permanent'?['reprocess']:['retry','reprocess'];
  return [];
}

/** Normalize a legacy status into the additive execution projection. */
export function executionEnvelope(input:LegacyExecutionInput):ExecutionEnvelope {
  const status=canonicalRunStatus(input),failure=failureFor(input,status),waiting=waitFor(input,status,failure);
  const attempts=numberValue(input.attempts)??0,maxAttempts=numberValue(input.maxAttempts);
  return executionEnvelopeSchema.parse({status,attempts,...(maxAttempts===undefined?{}:{maxAttempts}),...(failure?{failure}:{}),...(waiting?{waiting}:{}),allowedActions:actions(status,failure),...(stringValue(input.inputVersion)?{inputVersion:stringValue(input.inputVersion)}:{}),...(stringValue(input.definitionVersion)?{definitionVersion:stringValue(input.definitionVersion)}:{}),...(stringValue(input.updatedAt)?{updatedAt:stringValue(input.updatedAt)}:{})});
}

/** Exponential backoff with injected randomness for deterministic tests. */
export function retryDelay(policy:RetryPolicy,attempt:number,random=Math.random):number {
  const p=retryPolicySchema.parse(policy),n=Math.max(1,Math.min(attempt,31)),base=Math.min(p.maxDelayMs,p.baseDelayMs*2**(n-1));
  const spread=base*p.jitterRatio;
  return Math.max(0,Math.round(Math.min(p.maxDelayMs,base-spread+spread*2*Math.min(1,Math.max(0,random())))));
}

export function isTerminal(status:RunStatus):boolean {return status==='succeeded'||status==='failed'||status==='cancelled'||status==='skipped';}
