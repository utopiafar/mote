import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify,{type FastifyReply,type FastifyRequest} from 'fastify';
import {ZodError} from 'zod';
import {PluginResourceScope} from '@mote/plugin-host';
import type {HostScope} from '@mote/plugin-host';
import {createDynamicHttpDispatcher,DynamicHttpError,type DynamicHttpDispatcher} from '../src/plugins/dynamic-http-dispatcher.js';

function fixtureScope(name:string){
  const resources=new PluginResourceScope(undefined,'generated scope disposal failed');
  const scope:HostScope=Object.freeze({
    identity:{packageId:'generated.dynamic-http',installationId:'generated-install',instanceId:name,activationId:'generated-activation',host:{kind:'central' as const,id:'generated-host'}},
    signal:resources.signal,
    assertCurrent:()=>resources.assertCurrent(),
    defer:dispose=>resources.defer(dispose),
    run:work=>resources.run(work),
    every:(ms,work)=>resources.every(ms,work),
    retire:dispose=>resources.retire(dispose),
  });
  return {resources,scope};
}
function fixture(t:import('node:test').TestContext,authorize:(request:FastifyRequest)=>boolean=()=>true,mapError?:(error:unknown,request:FastifyRequest)=>{status:number;error:string}|undefined){
  const app=Fastify(),dispatcher: DynamicHttpDispatcher=createDynamicHttpDispatcher({authorize,...(mapError?{mapError}:{})});
  dispatcher.attach(app);t.after(async()=>{await app.close();});
  return {app,dispatcher};
}
const owner={authorization:'Bearer generated-owner'};
const route=(path:string,handler=(_request:FastifyRequest,reply:FastifyReply)=>reply.send({ok:true}))=>({method:'GET' as const,path:path as `/api/connectors/${string}`,handler});

test('static routes dispatch real owner handlers with auth, headers, body limits and mapped errors',async t=>{
  const a=fixtureScope('a');t.after(()=>a.resources.close());
  const {app,dispatcher}=fixture(t,request=>request.headers.authorization==='Bearer generated-owner');
  dispatcher.registerOwnerRoute(a.scope,route('/api/connectors/demo'));
  assert.equal((await app.inject('/api/connectors/demo')).statusCode,401);
  const ok=await app.inject({url:'/api/connectors/demo',headers:owner});
  assert.equal(ok.statusCode,200);assert.deepEqual(ok.json(),{ok:true});assert.equal(ok.headers['cache-control'],'no-store');
  dispatcher.registerOwnerRoute(a.scope,{method:'POST',path:'/api/connectors/empty',handler:(_request,reply)=>{reply.code(204).send();}});
  assert.equal((await app.inject({method:'POST',url:'/api/connectors/empty',headers:owner})).statusCode,204,'a legitimate undefined handler result is not a 503');
  dispatcher.registerOwnerRoute(a.scope,{method:'POST',path:'/api/connectors/limited',bodyLimit:16,handler:(_request,reply)=>reply.send({ok:true})});
  assert.equal((await app.inject({method:'POST',url:'/api/connectors/limited',headers:owner,payload:{value:'x'.repeat(100)}})).statusCode,413);
  dispatcher.registerOwnerRoute(a.scope,{method:'GET',path:'/api/connectors/fail',handler:()=>{throw Object.assign(new Error('generated'),{name:'ConnectorError',code:'generated_failure',statusCode:418});}});
  const failed=await app.inject({url:'/api/connectors/fail',headers:owner});
  assert.equal(failed.statusCode,418);assert.equal(failed.json().error,'generated_failure');assert.ok(failed.json().requestId);
  dispatcher.registerOwnerRoute(a.scope,{method:'GET',path:'/api/connectors/zod',handler:()=>{throw new ZodError([]);}});
  assert.equal((await app.inject({url:'/api/connectors/zod',headers:owner})).statusCode,400);
  assert.equal((await app.inject('/api/connectors/missing')).statusCode,404,'an unknown route stays 404 without auth');
  assert.throws(()=>dispatcher.registerOwnerRoute(a.scope,route('/evil')),error=>error instanceof DynamicHttpError&&error.code==='invalid_route');
});

test('route conflicts, sibling isolation and release drain one controlled inflight request',async t=>{
  const a=fixtureScope('a'),b=fixtureScope('b');t.after(async()=>{await a.resources.close();await b.resources.close();});
  const {app,dispatcher}=fixture(t);
  dispatcher.registerOwnerRoute(a.scope,route('/api/connectors/shared'));
  assert.throws(()=>dispatcher.registerOwnerRoute(b.scope,route('/api/connectors/shared')),error=>error instanceof DynamicHttpError&&error.code==='route_conflict');
  const bHandle=dispatcher.registerOwnerRoute(b.scope,route('/api/connectors/b'));
  const aHandle=dispatcher.registerOwnerRoute(a.scope,route('/api/connectors/a'));
  let releaseHandler!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{releaseHandler=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const heldHandle=dispatcher.registerOwnerRoute(a.scope,{method:'GET',path:'/api/connectors/held',handler:async(_request,reply)=>{entered();await held;return reply.send({ok:true});}});
  const pending=app.inject('/api/connectors/held');await started;
  let released=false;const releasing=heldHandle.release().then(()=>{released=true;});
  assert.equal(released,false,'release waits for the accepted inflight request');
  assert.equal((await app.inject('/api/connectors/held')).statusCode,404,'new requests are rejected after release');
  releaseHandler();assert.equal((await pending).statusCode,200);await releasing;assert.equal(released,true);
  assert.equal((await app.inject('/api/connectors/b')).statusCode,200,'a sibling route remains dispatchable');
  await aHandle.release();assert.equal((await app.inject('/api/connectors/a')).statusCode,404);assert.equal((await app.inject('/api/connectors/b')).statusCode,200);
  await bHandle.release();
});

test('OAuth shared path selects longest statePrefix, keeps default fallback and rejects new callbacks after release',async t=>{
  const google=fixtureScope('google'),gmail=fixtureScope('gmail'),dup=fixtureScope('dup');
  t.after(async()=>{await google.resources.close();await gmail.resources.close();await dup.resources.close();});
  const {app,dispatcher}=fixture(t);const calls:string[]=[];
  const gHandle=dispatcher.registerOAuthCallback(google.scope,{path:'/oauth/google/callback',complete:async(state)=>{calls.push('google:'+state);if(state.startsWith('gmail.'))throw new Error('generated wrong provider');},successMessage:'google-ok',failureMessage:'google-fail'});
  const mHandle=dispatcher.registerOAuthCallback(gmail.scope,{path:'/oauth/google/callback',statePrefix:'gmail.',complete:async(state)=>{calls.push('gmail:'+state);},successMessage:'gmail-ok',failureMessage:'gmail-fail'});
  assert.throws(()=>dispatcher.registerOAuthCallback(dup.scope,{path:'/oauth/google/callback',complete:async()=>{},successMessage:'dup-ok',failureMessage:'dup-fail'}),error=>error instanceof DynamicHttpError&&error.code==='oauth_default_conflict');
  const state='a'.repeat(24),query=`state=gmail.${state}&code=generated-code`;
  const gmailResponse=await app.inject('/oauth/google/callback?'+query);
  assert.equal(gmailResponse.statusCode,200);assert.equal(gmailResponse.body,'gmail-ok');
  assert.equal(gmailResponse.headers['cache-control'],'no-store');assert.equal(gmailResponse.headers['referrer-policy'],'no-referrer');assert.equal(gmailResponse.headers['content-security-policy'],"default-src 'none'; style-src 'none'");
  assert.equal((await app.inject(`/oauth/google/callback?state=${state}&code=generated-code`)).body,'google-ok');
  await mHandle.release();
  const late=await app.inject('/oauth/google/callback?'+query);
  assert.equal(late.statusCode,400);assert.equal(late.body,'google-fail');assert.equal(calls.filter(call=>call.startsWith('gmail:')).length,1);
  await gHandle.release();
  assert.equal((await app.inject(`/oauth/google/callback?state=${state}&code=generated-code`)).statusCode,404);
  assert.equal((await app.inject(`/oauth/unknown/callback?state=${state}&code=generated-code`)).statusCode,404);
});

test('quiesce rejects new owner requests, scope abort removes routes, and attach must precede listen',async t=>{
  const q=fixtureScope('q'),stopped=fixtureScope('stopped'),oauthQ=fixtureScope('oauth-q');
  t.after(async()=>{await q.resources.close();await stopped.resources.close();await oauthQ.resources.close();});
  const {app,dispatcher}=fixture(t);
  dispatcher.registerOwnerRoute(q.scope,route('/api/connectors/q'));
  q.resources.quiesce();
  assert.equal((await app.inject('/api/connectors/q')).statusCode,503,'H04 quiesce rejects new admission without confusing a valid handler result');
  dispatcher.registerOwnerRoute(stopped.scope,route('/api/connectors/stopped'));
  stopped.resources.stop();
  assert.equal((await app.inject('/api/connectors/stopped')).statusCode,404,'scope abort removes the route');
  const live=Fastify();await live.listen({host:'127.0.0.1',port:0});
  const late=createDynamicHttpDispatcher({authorize:()=>true});
  try{assert.throws(()=>late.attach(live),error=>error instanceof DynamicHttpError&&error.code==='dispatcher_attached');}finally{await live.close();}
  let completed=0;
  dispatcher.registerOAuthCallback(oauthQ.scope,{path:'/oauth/q/callback',complete:async()=>{completed++;},successMessage:'ok',failureMessage:'fail'});
  oauthQ.resources.quiesce();
  const response=await app.inject(`/oauth/q/callback?state=${'a'.repeat(24)}&code=generated-code`);
  assert.equal(response.statusCode,400);assert.equal(response.body,'fail');assert.equal(completed,0);
});

test('a failing scope cleanup still removes its route and leaves a sibling dispatchable',async t=>{
  const bad=fixtureScope('bad'),good=fixtureScope('good');
  const {app,dispatcher}=fixture(t);
  dispatcher.registerOwnerRoute(bad.scope,route('/api/connectors/bad'));
  dispatcher.registerOwnerRoute(good.scope,route('/api/connectors/good'));
  bad.resources.defer(()=>{throw new Error('generated cleanup failure');});
  await assert.rejects(bad.resources.close(),/generated scope disposal failed/);
  assert.equal((await app.inject('/api/connectors/bad')).statusCode,404);
  assert.equal((await app.inject('/api/connectors/good')).statusCode,200);
  await good.resources.close();
});
