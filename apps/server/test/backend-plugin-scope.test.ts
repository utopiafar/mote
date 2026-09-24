import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {BackendPluginScope} from '../src/backend-plugin-scope.js';

test('shared backend root keeps sibling plugin lifecycles independent',async()=>{
  const root=new Context(),first=new BackendPluginScope(root),second=new BackendPluginScope(root);
  const released:string[]=[];
  first.provide('fixtureFirst',{id:'first'});
  second.provide('fixtureSecond',{id:'second'});
  await first.install(ctx=>{ctx.effect(()=>()=>{released.push('first');});});
  await second.install(ctx=>{ctx.effect(()=>()=>{released.push('second');});});
  assert.equal(root.get('fixtureFirst').id,'first');
  assert.equal(root.get('fixtureSecond').id,'second');
  await first.close();
  assert.deepEqual(released,['first']);
  assert.equal(root.get('fixtureFirst'),undefined);
  assert.equal(root.get('fixtureSecond').id,'second');
  await second.close();
  assert.deepEqual(released,['first','second']);
  await root.fiber.dispose();
});

test('standalone runtime scope owns its root and closes idempotently',async()=>{
  const scope=new BackendPluginScope();let released=0;
  scope.provide('fixtureStandalone',{ready:true});
  await scope.install(ctx=>{ctx.effect(()=>()=>{released++;});});
  await scope.close();await scope.close();
  assert.equal(released,1);
  assert.equal(scope.context.get('fixtureStandalone'),undefined);
});
