import test from 'node:test';
import assert from 'node:assert/strict';
import {consumeLoginTicket} from '../src/login-handoff.js';
import {connectionStorageKey} from '../src/session.js';
function browser(t:any,code:string){
 const saved=new Map<string,PropertyDescriptor|undefined>(),values=new Map<string,string>();
 let href='https://fixture.invalid/#/ask?evidence=capture%3Agenerated&loginTicket='+code;
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,v:string)=>{values.set(key,v);},removeItem:(key:string)=>{values.delete(key);}};
 const location={get href(){return href;},get hash(){return new URL(href).hash;},get pathname(){return '/';},get search(){return '';}};
 const globals={location,history:{replaceState:(_a:any,_b:any,url:string)=>{href=new URL(url,href).href;}},sessionStorage:storage,localStorage:storage};
 for(const [key,value]of Object.entries(globals)){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true});}
 saved.set('fetch',Object.getOwnPropertyDescriptor(globalThis,'fetch'));
 t.after(()=>{for(const [key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}});
 return {storage,location};
}
test('native handoff consumes a one-time code before rendering and preserves evidence without another login',async t=>{
 const b=browser(t,'x'.repeat(43)),deadline=Date.now()+1000;let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'/api/login/exchange');assert.equal(init?.redirect,'error');assert.ok(!b.location.hash.includes('loginTicket'));return new Response(JSON.stringify({token:'generated'.repeat(8),expiresAt:deadline}));};
 await consumeLoginTicket();assert.equal(calls,1);assert.ok(b.location.hash.includes('evidence=capture%3Agenerated'));
 const c=JSON.parse(b.storage.getItem(connectionStorageKey)!);assert.equal(c.serverExpiresAt,deadline);assert.equal(c.expiresAt,deadline);
 await consumeLoginTicket();assert.equal(calls,1);
});
test('invalid, expired or replayed handoffs clear the previous login and cannot reuse an unrelated credential',async t=>{
 for(const code of ['invalid','x'.repeat(43)]){
  const b=browser(t,code);b.storage.setItem(connectionStorageKey,JSON.stringify({token:'generated-previous'}));
  globalThis.fetch=async()=>new Response('{}',{status:410});
  await assert.rejects(consumeLoginTicket());assert.equal(b.storage.getItem(connectionStorageKey),null);assert.ok(!b.location.hash.includes('loginTicket'));
 }
});
test('a late ticket response cannot replace a newer login or logout',async t=>{
 const b=browser(t,'x'.repeat(43));let active=true,resolve!:(response:Response)=>void;
 globalThis.fetch=async()=>new Promise<Response>(r=>{resolve=r;});
 const pending=consumeLoginTicket(()=>active);active=false;
 b.storage.setItem(connectionStorageKey,JSON.stringify({token:'generated-new-login'}));
 resolve(new Response(JSON.stringify({token:'generated-old-login'.repeat(3)})));
 await assert.rejects(pending,/Login changed/);
 assert.equal(JSON.parse(b.storage.getItem(connectionStorageKey)!).token,'generated-new-login');
});
