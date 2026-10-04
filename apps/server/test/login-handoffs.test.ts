import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {Connections, type ConnectionFile} from '../src/connections.js';
import {LoginHandoffs} from '../src/login-handoffs.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {buildApp, type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
const owner='generated-owner-login-fixture-token-123456789';
const headers=(token=owner)=>({authorization:'Bearer '+token});
const serverUrl='https://fixture.invalid';
const verifier=randomBytes(32).toString('base64url');
const input={serverUrl,deviceId:'generated-mac',deviceName:'Generated Mac',platform:'macos',challenge:createHash('sha256').update(verifier).digest('hex')};
async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'mote-login-fixture-'));
 const store=new Store(root),sources=new SourceStore(store);let now=Date.now(),saved:any;const cleanup={app:undefined as undefined|(()=>Promise<unknown>)};
 const file:ConnectionFile={read:async()=>saved,write:async value=>{saved=structuredClone(value);}};
 const connections=new Connections(store,sources,{clock:()=>now,file});await connections.init();
 t.after(async()=>{await cleanup.app?.();await connections.close();store.close();await rm(root,{recursive:true,force:true});});
 return {cleanup,root,store,sources,connections,handoffs:new LoginHandoffs(connections,()=>now),advance:(ms:number)=>{now+=ms;},saved:()=>saved};
}
test('handoff codes are single use, expire, honor the client deadline and recheck parent revocation',async t=>{
 const f=await fixture(t);const parent=await f.connections.session(serverUrl,'Generated');
 const active=()=>{const c=f.connections.authenticate('Bearer '+parent.token);assert.ok(c);f.connections.assertActive(c);};
 const first=f.handoffs.ticket(parent.token,active);
 assert.ok(!JSON.stringify(first).includes(parent.token));assert.equal(f.handoffs.exchange(first).token,parent.token);
 assert.throws(()=>f.handoffs.exchange(first));
 const expired=f.handoffs.ticket(parent.token,active);f.advance(60000);assert.throws(()=>f.handoffs.exchange(expired));
 const bounded=f.handoffs.ticket(parent.token,active,1);assert.throws(()=>f.handoffs.exchange(bounded));
 const revoked=f.handoffs.ticket(parent.token,active);await f.connections.revoke(parent.credentialId);assert.throws(()=>f.handoffs.exchange(revoked));
});
test('browser approval issues one full client grant and only the generating client can poll or acknowledge it',async t=>{
 const f=await fixture(t),{id}=f.handoffs.create(input);
 assert.deepEqual(f.handoffs.poll({id,verifier}),{ready:false});
 assert.throws(()=>f.handoffs.poll({id,verifier:'x'.repeat(43)}));
 assert.equal(f.handoffs.detail(id).deviceName,input.deviceName);assert.ok(!JSON.stringify(f.handoffs.detail(id)).includes(verifier));
 await Promise.all([f.handoffs.approve(id,()=>{}),f.handoffs.approve(id,()=>{})]);
 const grant=f.handoffs.poll({id,verifier}) as any;assert.equal(grant.scope,'owner');assert.equal(grant.ready,true);
 assert.equal(f.connections.inventory().items.length,1);assert.deepEqual(f.handoffs.poll({id,verifier}),grant);
 assert.ok(!JSON.stringify(f.saved()).includes(grant.token));assert.equal(f.connections.authenticate('Bearer '+grant.token)?.deviceId,input.deviceId);
 assert.throws(()=>f.handoffs.poll({id,verifier:'z'.repeat(43)},true));
 assert.deepEqual(f.handoffs.poll({id,verifier},true),{acknowledged:true});assert.throws(()=>f.handoffs.poll({id,verifier}));
 f.advance(30*86400000);assert.equal(f.connections.authenticate('Bearer '+grant.token),undefined);
});
test('failed or revoked approvals cannot publish a usable grant; pending requests are bounded and restart local',async t=>{
 const f=await fixture(t),{id}=f.handoffs.create(input);let checks=0;
 await assert.rejects(f.handoffs.approve(id,()=>{if(++checks===2)throw Error('Generated revoked parent');}));
 assert.equal(f.connections.inventory().items[0].revokedAt!==undefined,true);assert.deepEqual(f.handoffs.poll({id,verifier}),{ready:false});
 await f.handoffs.approve(id,()=>{});const grant=f.handoffs.poll({id,verifier}) as any;
 await f.connections.revoke(grant.credentialId);assert.throws(()=>f.handoffs.poll({id,verifier}));
 f.advance(10*60000);assert.throws(()=>f.handoffs.detail(id));
 for(let i=0;i<100;i++)f.handoffs.create(input);assert.throws(()=>f.handoffs.create(input));
 assert.throws(()=>new LoginHandoffs(f.connections).poll({id,verifier}));
});
test('retired collector credentials are refused without rewriting their saved hashes',async t=>{
 const f=await fixture(t);await f.connections.session(serverUrl,'Generated',{deviceId:'generated-phone',deviceName:'Generated phone',platform:'android'});
 const state=f.saved();state.credentials[0].scope='collector';const original=JSON.stringify(state);let writes=0;
 const retired=new Connections(f.store,f.sources,{file:{read:async()=>state,write:async()=>{writes++;}}});
 await assert.rejects(retired.init(),{code:'connection_storage_invalid'});assert.equal(JSON.stringify(state),original);assert.equal(writes,0);
});
