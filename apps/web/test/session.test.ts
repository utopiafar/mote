import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionForLifetime, restoreSession, sessionLifetime } from '../src/session.js';

const origin = 'https://mote.example';
test('restores current-service sessions and migrates old same-service credentials', () => {
  for (const value of [{token:'fixture'}, {url:'',token:'fixture'}, {url:origin,token:'fixture'}]) {
    assert.deepEqual(restoreSession(JSON.stringify(value), origin), {token:'fixture'});
  }
});
test('does not send a former remote-node credential to the current service', () => {
  for (const value of [{url:'https://other.example',token:'fixture'}, {url:42,token:'fixture'}, {token:''}, {token:42}, null]) {
    assert.equal(restoreSession(JSON.stringify(value), origin), null);
  }
  assert.equal(restoreSession('{', origin), null);
});
test('persistent sessions carry a browser expiry and expired credentials are rejected', () => {
  const now = Date.parse('2026-09-19T00:00:00.000Z');
  const connection = connectionForLifetime('fixture', '7d', now);
  assert.equal(connection.expiresAt, now + 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(restoreSession(JSON.stringify(connection), origin, now + 6 * 24 * 60 * 60 * 1000), connection);
  assert.equal(restoreSession(JSON.stringify(connection), origin, connection.expiresAt!), null);
  assert.equal(restoreSession(JSON.stringify(connection), origin, connection.expiresAt! + 1), null);
  assert.deepEqual(connectionForLifetime('fixture', 'session', now), {token:'fixture'});
});
test('unknown session lifetime values fall back to the safest tab-scoped mode', () => {
  assert.equal(sessionLifetime('30d'), '30d');
  assert.equal(sessionLifetime('forever'), 'session');
  assert.equal(sessionLifetime(undefined), 'session');
});

function browserStorage(t:any){
 const saved=new Map<string,PropertyDescriptor|undefined>();
 const make=()=>{const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};};
 const session=make(),local=make();
 for(const [key,value] of Object.entries({sessionStorage:session,localStorage:local})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true});}
 t.after(()=>{for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 return {session,local};
}
test('period survives same-session reload and lifetime changes without another token copy',async t=>{
 const {session}=browserStorage(t);const m=await import('../src/session.js');
 let c=m.persistSession({token:'generated-owner'},'session');m.savePeriod(c,'all');
 c=m.readStoredSession(origin)!;assert.equal(m.readPeriod(c),'all');
 const scope=c.viewScope;c=m.persistSession(c,'7d');assert.equal(c.viewScope,scope);assert.equal(m.readPeriod(m.readStoredSession(origin)),'all');
 assert.deepEqual(JSON.parse(session.getItem(m.periodStorageKey)!),{scope,period:'all'});
 assert.equal(m.savePeriod(c,'today'),'today');assert.equal(m.readPeriod(c),'today');
});
test('new login, logout, expiry and another tab login do not inherit a period',async t=>{
 const {local}=browserStorage(t);const m=await import('../src/session.js');
 const first=m.persistSession({token:'generated-a'},'7d');m.savePeriod(first,'all');
 const second=m.persistSession({token:'generated-b'},'7d');assert.notEqual(first.viewScope,second.viewScope);assert.equal(m.readPeriod(second),'week');
 m.savePeriod(second,'month');m.clearSession();assert.equal(m.readPeriod(m.readStoredSession(origin)),'week');
 m.persistSession({token:'expired'},'1d',0);assert.equal(m.readStoredSession(origin),null);assert.equal(m.readPeriod(null),'week');
 const current=m.persistSession({token:'current'},'7d');m.savePeriod(current,'all');
 local.setItem(m.connectionStorageKey,JSON.stringify({token:'other-tab',expiresAt:Date.now()+60000,viewScope:crypto.randomUUID()}));assert.equal(m.readPeriod(m.readStoredSession(origin)),'week');
});
test('legacy identity migration and invalid or foreign view state are safe',async t=>{
 const {session}=browserStorage(t);const m=await import('../src/session.js');
 session.setItem(m.connectionStorageKey,JSON.stringify({token:'legacy'}));const c=m.readStoredSession(origin)!;assert.ok(c.viewScope);assert.equal(m.readStoredSession(origin)!.viewScope,c.viewScope);
 m.savePeriod(c,'all');session.setItem(m.periodStorageKey,JSON.stringify({scope:c.viewScope,period:'arbitrary'}));assert.equal(m.readPeriod(c),'week');
 session.setItem(m.connectionStorageKey,JSON.stringify({token:'foreign',url:'https://other.example',viewScope:c.viewScope}));assert.equal(m.readPeriod(m.readStoredSession(origin)),'week');
 session.setItem(m.periodStorageKey,'{');assert.equal(m.readPeriod(c),'week');
});
test('blocked view storage keeps valid in-memory filtering available',async t=>{
 browserStorage(t);const m=await import('../src/session.js');const c=m.persistSession({token:'generated'},'session');
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw Error('blocked');}});
 assert.equal(m.readPeriod(c),'week');assert.equal(m.savePeriod(c,'all'),'all');assert.doesNotThrow(()=>m.clearSession());
});
