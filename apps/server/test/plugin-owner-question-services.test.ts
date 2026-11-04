import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import type {OwnerQuestionCreate,OwnerQuestionProvider} from '../src/owner-question-contract.js';
import {createOwnerQuestionServices,type OwnerQuestionServicesDependencies} from '../src/plugins/owner-question-services.js';

const question=(key:string):OwnerQuestionCreate=>({key,operationId:'generated:owner-questions',workId:'generated-work',title:'Generated owner question',prompt:'Confirm this generated value.',evidence:[],choices:[],dependencyIds:[]});
const authorization=():OwnerQuestionServicesDependencies['modelAuthorization']=>({manual:async<T>(_id:string,_connections:readonly unknown[],task:(signal:AbortSignal)=>Promise<T>)=>task(new AbortController().signal)});
function fixtureApp(plugin:ReturnType<typeof createOwnerQuestionServices>){
  const app=Fastify();
  app.setErrorHandler((error,_request,reply)=>reply.code(error.name==='ZodError'?400:(error as {statusCode?:number}).statusCode??500).send({error:error.message}));
  plugin.routes(app);
  return app;
}

test('owner-question activation fences new replies, drains accepted work and reuses one durable receipt after restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-owner-question-plugin-'));
  let store=new Store(directory);
  let plugin=createOwnerQuestionServices({store,credential:()=>undefined,modelAuthorization:authorization(),availableModelConnections:()=>[]});
  let app=Fastify();
  t.after(async()=>{try{await plugin.close();}catch{}try{await app.close();}catch{}try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  plugin.prepare();plugin.start();app=fixtureApp(plugin);
  let effects=0,entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const provider:OwnerQuestionProvider={id:'fixture.owner-question-plugin',version:'1',installationEpoch:'generated-installation',validate:()=>true,
    answer:async()=>{entered();await gate;return {kind:'continued',continuationId:'generated:continuation'};},
    commit:()=>{effects++;}};
  plugin.questions.register(provider);
  const first=plugin.questions.create(provider,question('first')),second=plugin.questions.create(provider,question('second'));
  const replyUrl='/api/owner-questions/'+first.id+'/reply';
  const reply={requestId:randomUUID(),expectedRevision:first.revision,action:'answer' as const,answer:'Generated owner answer.'};
  const pending=app.inject({method:'POST',url:replyUrl,payload:reply});
  await started;

  plugin.quiesce('disabled');
  assert.equal((await app.inject({url:'/api/owner-questions/'+first.id})).statusCode,200,'accepted reads survive quiesce');
  assert.equal((await app.inject({method:'POST',url:'/api/owner-questions/'+second.id+'/reply',payload:{requestId:randomUUID(),expectedRevision:second.revision,action:'answer',answer:'Generated rejected answer.'}})).statusCode,503,'quiesce rejects new replies');
  let stopped=false;
  const stopping=plugin.stop('disabled').then(()=>{stopped=true;});
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(stopped,false,'stop waits for an accepted reply');
  release();
  await stopping;
  const accepted=await pending;
  assert.equal(accepted.statusCode,200,accepted.body);
  assert.equal(accepted.json().state,'answered');assert.equal(accepted.json().continuationId,'generated:continuation');assert.equal(effects,1);
  assert.equal((await app.inject({url:'/api/owner-questions/'+first.id})).statusCode,503,'a stopped activation refuses reads until re-enabled');

  plugin.start();
  assert.equal((await app.inject({url:'/api/owner-questions/'+first.id})).json().state,'answered','the same route table serves the durable question after re-enable');
  const resumed=await app.inject({method:'POST',url:'/api/owner-questions/'+second.id+'/reply',payload:{requestId:randomUUID(),expectedRevision:second.revision,action:'answer',answer:'Generated resumed answer.'}});
  assert.equal(resumed.statusCode,200,resumed.body);assert.equal(resumed.json().state,'answered');assert.equal(effects,2);
  const replay=await app.inject({method:'POST',url:replyUrl,payload:reply});
  assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().revision,accepted.json().revision);assert.equal(effects,2,'the replay reuses the first receipt instead of running its effect again');
  assert.equal((await app.inject({method:'POST',url:replyUrl,payload:{...reply,answer:'Changed generated answer.'}})).statusCode,409,'a reused request ID with different content is rejected');

  await plugin.close();await app.close();store.close();
  store=new Store(directory);
  plugin=createOwnerQuestionServices({store,credential:()=>undefined,modelAuthorization:authorization(),availableModelConnections:()=>[]});
  plugin.prepare();plugin.start();app=fixtureApp(plugin);
  let restartedEffects=0;
  plugin.questions.register({id:'fixture.owner-question-plugin',version:'1',installationEpoch:'generated-installation',validate:()=>true,
    answer:async()=>{restartedEffects++;return {kind:'continued',continuationId:'generated:second-continuation'};},
    commit:()=>{restartedEffects++;}});
  const restored=(await app.inject({url:'/api/owner-questions/'+first.id})).json();
  assert.equal(restored.state,'answered');assert.equal(restored.continuationId,'generated:continuation');
  assert.equal((await app.inject({method:'POST',url:replyUrl,payload:reply})).statusCode,200);
  assert.equal(restartedEffects,0,'a replayed HTTP ACK never runs the provider effect twice');
  assert.equal(store.db.prepare('SELECT count(*) n FROM owner_question_replies').get()!.n,2);
});
