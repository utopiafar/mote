import {Context} from '@deepseek-ai/cordis';
import {FeatureRegistry} from '@mote/shared';
import {createOfficialReadPacks,defineToolDescriptor,type ToolDescriptor,type ReadPackRegistration,type ContextReader} from '@mote/agent';
import {StoreError} from '../store.js';
import type {HostContributionDescriptor} from '../feature-inventory.js';

const groups:Record<string,(keyof ContextReader)[]>={
  context:['catalog','search','timeline','evidence'],materials:['materialCatalog','materialRead'],
  capture:['readImage','segments','activity'],files:['readFileEvidence','fileChunks'],media:['mediaActivity'],
  sources:['sourceHistory','sources','sourceContext','sourceItems'],memory:['memories'],devices:['devices'],
};

/** Query agents and the owner-only inspector dispatch through the same read-only
 * registrations. Read tools remain scoped to their feature activation; a
 * disabled feature revokes its registrations without touching retained data. */
export async function installAgentReadTools(root:Context,implementation:ContextReader,enabled:(featureId:string)=>boolean=()=>true){
  const rootLifetime=new AbortController(),lifetimes=new WeakMap<Function,AbortSignal>();
  root.effect(()=>()=>rootLifetime.abort(new StoreError('Agent capability unavailable',503)));
  const registry=new FeatureRegistry<Function>(),reader={} as ContextReader,fibers=new Map<string,{dispose():Promise<void>}>();
  reader.contextTools=facts=>{
    const batches:ReadPackRegistration[]=[];
    const add=(descriptor:ToolDescriptor,owner?:Function)=>{
      const pins=descriptor.requires.flatMap(permission=>permission==='progress'||permission==='actionCatalog'?[]:[{key:'agent:'+permission,value:registry.get('agent:'+permission)}]);
      if(pins.some(pin=>!pin.value))return;
      const origins=[...(owner?[owner]:[]),...pins.map(pin=>pin.value!)];
      if(origins.some(origin=>!lifetimes.has(origin)))return;
      const signal=AbortSignal.any([rootLifetime.signal,...origins.map(origin=>lifetimes.get(origin)!)]);
      batches.push({descriptors:[descriptor],lifecycle:{signal,assertCurrent(){
        signal.throwIfAborted();
        if(pins.some(pin=>registry.get(pin.key)!==pin.value)||owner&&registry.get('agent-tool:'+descriptor.name)!==owner)throw new StoreError('Agent capability unavailable',503);
      }}});
    };
    for(const descriptor of createOfficialReadPacks(facts))add(descriptor);
    for(const entry of registry.list('agent'))if(entry.descriptor.id.startsWith('agent-tool:'))add(entry.value(),entry.value);
    return Object.freeze(batches);
  };
  for(const [name,keys] of Object.entries(groups)){
    const featureId='mote.'+name;
    if(!enabled(featureId))continue;
    const fiber=root.plugin((ctx:Context)=>{
      const lifetime=new AbortController();ctx.effect(()=>()=>lifetime.abort(new StoreError('Agent capability unavailable',503)));
      ctx.effect(()=>registry.install({id:featureId,version:'1',components:keys.map(key=>({id:'agent:'+key,version:'1',surface:'agent'}))}));
      for(const key of keys){const fn=implementation[key];if(!fn)continue;
        // A registration has its own call identity even if a replacement
        // provider reuses the same implementation function.
        const call=(...args:unknown[])=>(fn as Function)(...args);lifetimes.set(call,lifetime.signal);
        ctx.effect(()=>registry.register(featureId,{id:'agent:'+key,version:'1',surface:'agent'},call));
        Object.defineProperty(reader,key,{enumerable:true,value:async(...args:unknown[])=>{
          const active=registry.get('agent:'+key);if(!active)throw new StoreError('Agent capability unavailable',503);
          const result=await active(...args);
          if(registry.get('agent:'+key)!==active)throw new StoreError('Agent capability unavailable',503);
          return result;
        }});
      }
    });
    await fiber;fibers.set(featureId,fiber);
  }
  return {registry,reader,
    /** Read-tool registrations stay owned by their Agent feature scope; the
     * feature inventory projects them without exposing callables. */
    contributions():HostContributionDescriptor[]{
      const inventory=registry.inventory();
      return inventory.features.map(feature=>({
        id:'agent-feature:'+feature.id,version:feature.version,surface:'agent',runtime:'host',
        featureId:feature.id,featureVersion:feature.version,self:false,state:inventory.capabilities.some(capability=>capability.featureId===feature.id&&capability.state==='active')?'active':'unavailable',
        components:inventory.capabilities.filter(capability=>capability.featureId===feature.id).map(({featureId:_featureId,state,reason,...component})=>({...component,state,...(reason?{reason}:{})})),
      }));
    },
    registerTools:(featureId:string,contributions:readonly ToolDescriptor[])=>{
    const descriptors=contributions.map(defineToolDescriptor),ownerId=featureId+':tools';
    const fiber=root.plugin((ctx:Context)=>{
      const lifetime=new AbortController();ctx.effect(()=>()=>lifetime.abort(new StoreError('Agent capability unavailable',503)));
      const components=descriptors.map(tool=>({id:'agent-tool:'+tool.name,version:tool.version,surface:'agent' as const}));
      ctx.effect(()=>registry.install({id:ownerId,version:'1',components}));
      for(const [index,descriptor]of descriptors.entries()){
        const value=()=>descriptor;lifetimes.set(value,lifetime.signal);
        ctx.effect(()=>registry.register(ownerId,components[index],value));
      }
    });
    const existing=fibers.get(featureId);fibers.set(featureId,{dispose:async()=>{await fiber.dispose();await existing?.dispose();}});return fiber;
  },dispose:async(id:string)=>{await fibers.get(id)?.dispose();fibers.delete(id);}};
}
