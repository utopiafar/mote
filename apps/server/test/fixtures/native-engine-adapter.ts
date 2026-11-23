import type {PluginInstanceView} from '@mote/shared';
import type {buildApp} from '../../src/app.js';
import type {MemoryEngine} from '../../src/memory-native-stage-contract.js';

/** Replace plugin discovery/native transport only. Actual app admission,
 * native-stage observers, integration lifecycle and durable receipts still run. */
export function generatedNativeAdapter(node:Awaited<ReturnType<typeof buildApp>>,engine:MemoryEngine){
  const bindings=node.memoryBindings!,binding=bindings.binding();
  const namespace={ownerId:'mote-owner',instanceId:'generated-native-input-handoff',bindingRevision:binding.generation};
  const instance:PluginInstanceView={
    id:namespace.instanceId,packageId:'generated-native',name:'Generated native engine',revision:1,scope:'owner',configurationSchema:[],
    configuration:{modelProfileId:node.modelSettings.select('memory').id},secretStatus:{},capabilities:[{id:'engine',state:'verified'}],
    desired:true,observed:'ready',issues:[],allowedActions:[],
  };
  const instanceView=node.pluginCenter.instanceView.bind(node.pluginCenter);
  const pluginView=node.pluginCenter.view.bind(node.pluginCenter);
  node.pluginCenter.instanceView=id=>id===instance.id?instance:instanceView(id);
  node.pluginCenter.view=()=>{
    const view=pluginView();
    return {...view,instances:[...view.instances,instance]};
  };
  // Use the same instance plan ID that a real activation persists, so the
  // actual binding resolver selects the generated engine capability.
  bindings.binding=()=>({planId:'instance:'+instance.id,generation:binding.generation,namespace});
  bindings.accepting=()=>true;
  bindings.read=async id=>node.memories.get(id);
  node.memoryAdapters.configurationIdentity=()=> 'generated-native-input-handoff@1';
  node.memoryAdapters.engine=()=>engine;
  // Native stage cleanup is an independent transport, outside these handoff tests.
  node.memoryAdapters.discardPrepared=async()=>{};
}
