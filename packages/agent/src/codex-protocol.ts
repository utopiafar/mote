import {providerHttpFailure,type ProviderFailureDetails,type TokenUsage} from '@mote/shared';

/** App Server v2 discriminants, checked against the installed generate-ts schema.
 * Never classify the provider's free-form message or additionalDetails. */
export function codexFailure(value:unknown):ProviderFailureDetails {
  const code=typeof value==='string'?value:undefined;
  if(code==='unauthorized')return {category:'blocked',code:'provider_authentication'};
  if(code==='usageLimitExceeded'||code==='sessionBudgetExceeded')return {category:'blocked',code:'provider_quota'};
  if(code==='rateLimitExceeded')return {category:'transient',code:'rate_limited'};
  if(code==='serverOverloaded'||code==='internalServerError')return {category:'transient',code:'provider_unavailable'};
  if(code==='contextWindowExceeded')return {category:'permanent',code:'processing_limit'};
  if(code==='badRequest')return {category:'permanent',code:'provider_request_invalid'};
  if(code==='cyberPolicy'||code==='misalignmentPolicyViolation')return {category:'permanent',code:'provider_policy'};
  if(value&&typeof value==='object')for(const key of ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']){
    const detail=(value as Record<string,unknown>)[key];
    if(!detail||typeof detail!=='object')continue;
    const status=(detail as {httpStatusCode?:unknown}).httpStatusCode;
    if(typeof status==='number'&&Number.isInteger(status)&&status>=300&&status<=599)return providerHttpFailure(status);
    return {category:'transient',code:'provider_network'};
  }
  return {category:'permanent',code:'provider_failed'};
}
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
/** A thread total replaces the previous total, including repair turns. App Server
 * does not expose a reliable underlying request count; do not invent one. */
export function codexUsage(value:unknown):TokenUsage|undefined {
  if(!value||typeof value!=='object')return;
  const u=(value as {total?:Record<string,unknown>}).total;if(!u)return;
  if(!count(u.inputTokens)||!count(u.outputTokens)||!count(u.totalTokens)||u.totalTokens!==u.inputTokens+u.outputTokens)return;
  for(const key of ['cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens'])if(u[key]!==undefined&&!count(u[key]))return;
  if(Number(u.cachedInputTokens??0)+Number(u.cacheWriteInputTokens??0)>u.inputTokens||Number(u.reasoningOutputTokens??0)>u.outputTokens)return;
  return {measurement:'thread_cumulative',complete:true,requests:0,reportedRequests:0,inputTokens:u.inputTokens,outputTokens:u.outputTokens,totalTokens:u.totalTokens,
    ...(count(u.cachedInputTokens)?{cacheReadTokens:u.cachedInputTokens}:{}),...(count(u.cacheWriteInputTokens)?{cacheWriteTokens:u.cacheWriteInputTokens}:{}),...(count(u.reasoningOutputTokens)?{reasoningTokens:u.reasoningOutputTokens}:{})};
}
