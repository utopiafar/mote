import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ProviderFailure} from '@mote/shared';import {Store} from '../src/store.js';import {ProviderAdmission} from '../src/provider-admission.js';import {ConcurrencyGate} from '../src/concurrency.js';
const settings={protocol:'openai-completions' as const,provider:'custom',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'generated-private-key',headers:{'X-Fixture':'generated-private-header'}};
test('provider cooldown survives reconstruction, shares credentials across models, and never persists settings',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-provider-admission-')),store=new Store(dir),other=new Store(dir);let now=10000,calls=0;
 t.after(()=>{other.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const first=new ProviderAdmission(store,()=>now),second=new ProviderAdmission(other,()=>now);
 await assert.rejects(first.run(settings,async()=>{calls++;throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:12000});}),ProviderFailure);
 await assert.rejects(second.run({...settings,baseUrl:settings.baseUrl+'/'},async()=>{calls++;return 1;}),error=>error instanceof ProviderFailure&&error.details.retryAfterMs===12000);assert.equal(calls,1);
 const saved=JSON.stringify(store.db.prepare('SELECT * FROM provider_cooldowns').all());for(const value of [settings.apiKey,settings.headers['X-Fixture'],settings.baseUrl])assert.ok(!saved.includes(value));
 assert.equal(await second.run({...settings,apiKey:'independent-generated-key'},async()=>42),42);assert.deepEqual(first.snapshot(),{coolingDown:1,nextEligibleAt:22000});
 now=22000;assert.equal(await new ProviderAdmission(store,()=>now).run(settings,async()=>42),42);assert.equal(first.snapshot().coolingDown,0);
});
test('work queued before a rate limit rechecks admission and independent providers keep progressing',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-provider-queued-')),store=new Store(dir),admission=new ProviderAdmission(store),gate=new ConcurrencyGate(1);t.after(()=>{gate.close();store.close();rmSync(dir,{recursive:true,force:true});});
 let release!:()=>void,entered!:()=>void,calls=0;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const first=gate.run(()=>admission.run(settings,async()=>{calls++;entered();await held;throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:30000});}));const fail=assert.rejects(first,ProviderFailure);await started;
 const waiting=gate.run(()=>admission.run(settings,async()=>{calls++;return 1;})),denied=assert.rejects(waiting,ProviderFailure),independent=gate.run(()=>admission.run({...settings,baseUrl:'http://127.0.0.1:2345'},async()=>42));release();await fail;await denied;assert.equal(await independent,42);assert.equal(calls,1);
});
test('an in-flight success cannot erase another request cooldown, and input errors do not block a provider',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-provider-late-')),store=new Store(dir),admission=new ProviderAdmission(store);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let release!:()=>void;const held=new Promise<void>(r=>release=r),success=admission.run(settings,async()=>{await held;return 42;});
 await assert.rejects(admission.run(settings,async()=>{throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:60000});}),ProviderFailure);release();assert.equal(await success,42);assert.throws(()=>admission.check(settings),ProviderFailure);
 const other={...settings,apiKey:'other'};await assert.rejects(admission.run(other,async()=>{throw new ProviderFailure({category:'permanent',code:'provider_request_invalid'});}),ProviderFailure);assert.doesNotThrow(()=>admission.check(other));
});
