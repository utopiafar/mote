import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {centralServices,type ConversationRepository} from '../src/plugins/central-contracts.js';
import {
  createConversations,createConversationsFactory,createConversationRoutes,
  conversationsDeclaration,type ConversationsBindings,
} from '../src/plugins/conversations.js';

const result=()=>({answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[]}});
const authorization={conversation(_turnId:string){}};

async function install(host:PluginHost,store:Store,routes:ReturnType<typeof createConversationRoutes>){
  const platform=createConversations(store,authorization);let bindings:ConversationsBindings|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:'generated.conversations',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[conversationsDeclaration],factory:createConversationsFactory(platform,value=>{bindings=value;routes.activate(platform.conversations);}),
  });
  const lease=await host.acquire(centralServices.conversations,bindings!.conversations);
  return {platform,handle,conversations:lease.value,async close(){await lease.release();await handle.close('disabled');}};
}

test('conversation writes quiesce, routes survive a fresh activation, and history survives host restart',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-conversation-plugin-')),store=new Store(directory),app=Fastify({logger:false}),routes=createConversationRoutes();
  let host=new PluginHost({kind:'central',id:'generated-conversation-host'});
  t.after(async()=>{await host.close();await app.close();store.close();rmSync(directory,{recursive:true,force:true});});
  let current=await install(host,store,routes);routes.mount(app);
  const saved=current.conversations.append(undefined,{question:'Generated durable question'},result());
  assert.equal(current.conversations.get(saved.conversationId).turnCount,1);

  await current.handle.quiesce('disabled');
  assert.throws(()=>current.conversations.append(undefined,{question:'Rejected during quiesce'},result()),{statusCode:503});
  assert.equal((await app.inject({url:`/api/conversations/${saved.conversationId}`})).statusCode,200);
  await current.close();
  assert.throws(()=>current.platform.conversations.append(undefined,{question:'Rejected after stop'},result()),{statusCode:503});
  assert.equal((await app.inject({url:`/api/conversations/${saved.conversationId}`})).statusCode,503);

  current=await install(host,store,routes);
  assert.equal((await app.inject({url:`/api/conversations/${saved.conversationId}`})).statusCode,200);
  current.conversations.append(current.conversations.get(saved.conversationId),{question:'Generated after reactivation'},result());
  assert.equal(current.conversations.get(saved.conversationId).turnCount,2);
  await current.close();

  await host.close();host=new PluginHost({kind:'central',id:'generated-conversation-restarted-host'});
  current=await install(host,store,routes);
  const restored=current.conversations.get(saved.conversationId);
  assert.deepEqual(restored.turns.map(turn=>turn.question),['Generated durable question','Generated after reactivation']);
  await current.close();
});

test('a failed prepare publishes no usable repository and close remains idempotent',async()=>{
  const failure=new Error('Generated conversation DDL failure');
  const broken={db:{exec(){throw failure;},prepare(){throw failure;},get isTransaction(){return false;}},reserveMetadata(){}} as unknown as Store;
  const platform=createConversations(broken,authorization);
  await assert.rejects(platform.prepare(),failure);
  const conversations:ConversationRepository=platform.conversations;
  assert.throws(()=>conversations.list(),{statusCode:503});
  await platform.close();await platform.close();
  assert.deepEqual(conversationsDeclaration,{id:'conversations',apiVersion:'1'});
});
