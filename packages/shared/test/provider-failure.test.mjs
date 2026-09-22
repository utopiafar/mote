import test from 'node:test';
import assert from 'node:assert/strict';
import {providerHttpFailure,retryAfterMilliseconds} from '../dist/provider-failure.js';
test('transport status determines recovery without reading provider text',()=>{
 assert.deepEqual(providerHttpFailure(401),{category:'blocked',code:'provider_authentication'});assert.equal(providerHttpFailure(403).category,'blocked');assert.equal(providerHttpFailure(404).code,'provider_endpoint');assert.equal(providerHttpFailure(302).code,'provider_redirect');
 assert.deepEqual(providerHttpFailure(429,'17'),{category:'transient',code:'rate_limited',retryAfterMs:17000});assert.equal(providerHttpFailure(503).category,'transient');assert.equal(providerHttpFailure(413).category,'permanent');assert.equal(providerHttpFailure(400).category,'permanent');
});
test('Retry-After accepts bounded seconds or HTTP date and rejects malformed values',()=>{
 const now=Date.UTC(2026,8,22);assert.equal(retryAfterMilliseconds('Tue, 22 Sep 2026 00:00:08 GMT',now),8000);assert.equal(retryAfterMilliseconds('Mon, 21 Sep 2026 00:00:00 GMT',now),0);assert.equal(retryAfterMilliseconds('999999999'),7*86400000);
 for(const value of ['-1','0.5','2026-09-22','private-secret', 'x'.repeat(200)])assert.equal(retryAfterMilliseconds(value,now),undefined);
});
