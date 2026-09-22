import test from 'node:test';
import assert from 'node:assert/strict';
import {codexFailure,codexUsage} from '../dist/codex-protocol.js';
test('App Server errors classify only structured discriminants and HTTP status',()=>{
  for(const [value,category,code] of [
    ['usageLimitExceeded','blocked','provider_quota'],['rateLimitExceeded','transient','rate_limited'],['unauthorized','blocked','provider_authentication'],
    [{responseStreamDisconnected:{httpStatusCode:429}},'transient','rate_limited'],[{httpConnectionFailed:{httpStatusCode:401}},'blocked','provider_authentication'],
    [{responseStreamConnectionFailed:{httpStatusCode:null}},'transient','provider_network'],['contextWindowExceeded','permanent','processing_limit'],
    ['message includes 429 rate limit','permanent','provider_failed'],[{message:'unauthorized'},'permanent','provider_failed'],
  ])assert.deepEqual(codexFailure(value),{category,code});
});
test('Codex totals validate disjoint buckets and preserve missing cache fields as unknown',()=>{
  const total={inputTokens:100,outputTokens:50,totalTokens:150,cachedInputTokens:30,reasoningOutputTokens:10};
  assert.equal(codexUsage({total}).cacheWriteTokens,undefined);
  for(const invalid of [{...total,totalTokens:151},{...total,cachedInputTokens:101},{...total,reasoningOutputTokens:51},{...total,inputTokens:NaN}])assert.equal(codexUsage({total:invalid}),undefined);
});
