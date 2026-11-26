import type {StateLimits,StateStore} from '@mote/plugin-api';
import type {TestContext} from 'node:test';
import type {HostScope} from '@mote/plugin-host';
import {StoreError,type EvidenceStore as Store} from '../../src/evidence-store.js';
import {createVaultInstanceState,InstanceState} from '../../src/plugin-instance-state-storage.js';
import {createVaultPluginControlStore} from '../../src/plugin-control-storage.js';
import {Context} from '@deepseek-ai/cordis';
import type {FastifyInstance} from 'fastify';
import {registerConnectors,type ConnectorContext,type ConnectorTestDependencies} from '../../src/connectors/index.js';
import type {ConnectorManifest} from '../../src/connectors/registry.js';

/** An isolated SQLite fixture is its own trusted storage owner. Production
 * obtains these capabilities from the live Vault assembly instead. */
const current=(store:Store)=>{if(!store.db.isOpen)throw new StoreError('Generated plugin storage is closed',503);};
export function testInstanceState(store:Store,scope:HostScope,limits?:StateLimits,sourceKinds:readonly string[]=[]){
  return createVaultInstanceState(store,scope,()=>current(store),limits,sourceKinds);
}

/** Install before activation binds the private state methods to its facade. */
export function holdNextCheckpoint(t:TestContext,checkpointKey:string){
  const compareAndSet=InstanceState.prototype.compareAndSet;
  let armed=true,enter!:(condition:Parameters<StateStore['compareAndSet']>[3])=>void,release!:()=>void;
  const entered=new Promise<Parameters<StateStore['compareAndSet']>[3]>(resolve=>enter=resolve);
  const gate=new Promise<void>(resolve=>release=resolve);
  t.mock.method(InstanceState.prototype,'compareAndSet',async function(this:InstanceState,...args:Parameters<StateStore['compareAndSet']>){
    const [key,,value,condition]=args;
    if(armed&&key===checkpointKey&&value&&typeof value==='object'&&'processed' in value&&value.processed===1){
      armed=false;enter(condition);await gate;
    }
    return compareAndSet.apply(this,args);
  });
  return {entered,release};
}
export function testPluginControl(store:Store){return createVaultPluginControlStore(store,()=>current(store));}
export function testPluginStorage(store:Store){
  return {
    controlForScope:(scope:HostScope)=>createVaultPluginControlStore(store,()=>{current(store);scope.assertCurrent();}),
    stateForScope:(scope:HostScope,sourceKinds:readonly string[])=>testInstanceState(store,scope,undefined,sourceKinds),
  };
}

/** Older connector fixtures supply their context directly. Give the actual
 * current registration entrypoint its own generated Cordis owner and storage. */
export async function testRegisterConnectors(app:FastifyInstance,context:ConnectorContext,testing?:ConnectorTestDependencies,manifests:readonly ConnectorManifest[]=[]){
  const owner=new Context();app.addHook('onClose',()=>owner.fiber.dispose());
  try{return await registerConnectors(app,owner,context,testPluginStorage(context.store),testing,manifests);}
  catch(error){await owner.fiber.dispose();throw error;}
}
