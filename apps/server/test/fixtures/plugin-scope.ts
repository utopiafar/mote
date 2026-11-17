import type {TestContext} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import {PluginResourceScope,type HostScope} from '@mote/plugin-host';

let sequence=0;

/** Generated fixtures explicitly own their root; production receives an owner. */
export function createTestScope(){
  const cordis=new Context(),resources=new PluginResourceScope(),id=String(++sequence);
  resources.retire(()=>cordis.fiber.dispose());
  const scope:HostScope={
    identity:{host:{kind:'central',id:'generated-root-'+id},packageId:'generated.runtime',installationId:id,instanceId:id,activationId:id},
    cordis,signal:resources.signal,assertCurrent:()=>resources.assertCurrent(),
    defer:dispose=>resources.defer(dispose),retire:dispose=>resources.retire(dispose),
    every:(ms,work)=>resources.every(ms,work),run:work=>resources.run(work),
  };
  return {scope,close:()=>resources.close()};
}

export function testScope(t:Pick<TestContext,'after'>):HostScope{
  const owner=createTestScope();
  t.after(()=>owner.close());
  return owner.scope;
}
