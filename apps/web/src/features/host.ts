import { Context } from '@deepseek-ai/cordis';
import { FeatureRegistry,type FeatureManifest } from '@mote/shared';
import type { CollectionEntry,PageEntry,ViewEntry,HomeEntry,ActionEntry } from './types';
export type WebContribution={surface:'page';entry:PageEntry}|{surface:'renderer'|'panel'|'card';entry:ViewEntry}|{surface:'collection';entry:CollectionEntry}|{surface:'home';entry:HomeEntry}|{surface:'action';entry:ActionEntry};
export function contributionDescriptor(value:WebContribution){
  return {id:value.surface+':'+value.entry.id,version:value.entry.version??'1',surface:value.surface,
    ...(value.entry.requires?.length?{requires:value.entry.requires.map(dep=>typeof dep==='string'?{id:dep,version:'1',host:'server' as const}:dep)}:{})};
}
/** An independent browser Context; React subscribes to its disposable registrations. */
export class WebFeatureHost {
  readonly context=new Context();
  readonly registry=new FeatureRegistry<WebContribution>();
  async install(manifest:FeatureManifest,contributions:WebContribution[]){
    const descriptors=contributions.map(contributionDescriptor);
    const declared=manifest.components.length?manifest:{...manifest,components:descriptors};
    const fiber=this.context.plugin((ctx:Context)=>{
      ctx.effect(()=>this.registry.install(declared));
      for(const value of contributions)ctx.effect(()=>this.registry.register(manifest.id,contributionDescriptor(value),value));
    });
    try{await fiber;return fiber;}catch(error){await fiber.dispose();throw error;}
  }
  pages(){return this.registry.list('page').flatMap(({value})=>value.surface==='page'?[value.entry]:[]);}
  homes(){return this.registry.list('home').flatMap(({value})=>value.surface==='home'?[value.entry]:[]).sort((a,b)=>a.order-b.order);}
  collections(){return this.registry.list('collection').flatMap(({value})=>value.surface==='collection'?[value.entry]:[]).sort((a,b)=>a.order-b.order);}
  page(id:string){const value=this.registry.get('page:'+id);return value?.surface==='page'?value.entry:undefined;}
  views(surface:'renderer'|'panel'|'card'|'action',value:Pick<ViewEntry,'kind'|'schemaVersion'|'representation'>){return this.registry.list(surface).flatMap(({value:entry})=>entry.surface===surface&&entry.entry.kind===value.kind&&entry.entry.schemaVersion===value.schemaVersion&&entry.entry.representation===value.representation?[entry.entry]:[]);}
  close(){return this.context.fiber.dispose();}
}
