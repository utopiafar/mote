import {Context} from '@deepseek-ai/cordis';
import {FeatureRegistry} from '@mote/shared';
import type {ContextReader} from '@mote/agent';
import {StoreError} from './store.js';
const groups:Record<string,(keyof ContextReader)[]>={
  context:['catalog','search','timeline','evidence'],materials:['materialCatalog','materialRead'],
  capture:['readImage','segments','activity'],files:['readFileEvidence','fileChunks'],media:['mediaActivity'],
  sources:['sourceHistory','sources','sourceItems'],memory:['memories'],devices:['devices'],
};
/** Query agents and the owner-only inspector dispatch through the same read-only registrations. */
export async function installAgentFeatures(root:Context,implementation:ContextReader){
  const registry=new FeatureRegistry<Function>(),reader={} as ContextReader;
  for(const [name,keys] of Object.entries(groups)){
    const featureId='mote.'+name;
    await root.plugin((ctx:Context)=>{
      ctx.effect(()=>registry.install({id:featureId,version:'1',components:keys.map(key=>({id:'agent:'+key,version:'1',surface:'agent'}))}));
      for(const key of keys){const fn=implementation[key];if(!fn)continue;
        ctx.effect(()=>registry.register(featureId,{id:'agent:'+key,version:'1',surface:'agent'},fn));
        Object.defineProperty(reader,key,{enumerable:true,value:(...args:unknown[])=>{const active=registry.get('agent:'+key);if(!active)throw new StoreError('Agent capability unavailable',503);return active(...args);}});
      }
    });
  }
  return {registry,reader};
}
