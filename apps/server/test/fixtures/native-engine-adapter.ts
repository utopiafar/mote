import type {buildApp} from '../../src/app.js';
import type {HindsightEngine} from '../../src/hindsight-engine.js';

/** Replace plugin discovery/native transport only. Actual app admission,
 * engineDraft observers, integration lifecycle and durable receipts still run. */
export function generatedNativeAdapter(node:Awaited<ReturnType<typeof buildApp>>,engine:Pick<HindsightEngine,'prepare'>){
  const bindings=node.memoryBindings!,view=bindings.view(),binding=bindings.binding();
  const namespace={ownerId:'mote-owner',instanceId:'generated-native-input-handoff',bindingRevision:binding.generation};
  const instanceView=node.pluginCenter.instanceView.bind(node.pluginCenter);
  node.pluginCenter.instanceView=id=>id===namespace.instanceId?{id,packageId:'generated-native',name:'Generated native engine',revision:1,scope:'owner',configurationSchema:[],configuration:{modelProfileId:node.modelSettings.select('memory').id},secretStatus:{},capabilities:[],desired:true,observed:'ready',issues:[],allowedActions:[]}:instanceView(id);
  bindings.binding=()=>({...binding,namespace});
  bindings.view=()=>({...view,mode:'engine'});
  bindings.accepting=()=>true;
  bindings.read=async id=>node.memories.get(id);
  node.memoryAdapters.configurationIdentity=()=> 'generated-native-input-handoff@1';
  node.memoryAdapters.engine=()=>engine as HindsightEngine;
  // Native stage cleanup is an independent transport, outside these handoff tests.
  node.memoryAdapters.discardPrepared=async()=>{};
}
