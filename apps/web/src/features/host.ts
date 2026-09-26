import { Context } from '@deepseek-ai/cordis';
import { FeatureRegistry,type FeatureManifest } from '@mote/shared';
import type { CollectionEntry,PageEntry,ViewEntry } from './types';
export type WebContribution={surface:'page';entry:PageEntry}|{surface:'renderer'|'panel';entry:ViewEntry}|{surface:'collection';entry:CollectionEntry};
/** An independent browser Context; React subscribes to its disposable registrations. */
export class WebFeatureHost {
  readonly context=new Context();
  readonly registry=new FeatureRegistry<WebContribution>();
  async install(manifest:FeatureManifest,contributions:WebContribution[]){
    const fiber=this.context.plugin((ctx:Context)=>{
      ctx.effect(()=>this.registry.install(manifest));
      for(const value of contributions)ctx.effect(()=>this.registry.register(manifest.id,{id:value.surface+':'+value.entry.id,version:'1',surface:value.surface},value));
    });
    try{await fiber;return fiber;}catch(error){await fiber.dispose();throw error;}
  }
  pages(){return this.registry.list('page').flatMap(({value})=>value.surface==='page'?[value.entry]:[]);}
  collections(){return this.registry.list('collection').flatMap(({value})=>value.surface==='collection'?[value.entry]:[]).sort((a,b)=>a.order-b.order);}
  page(id:string){const value=this.registry.get('page:'+id);return value?.surface==='page'?value.entry:undefined;}
  views(surface:'renderer'|'panel',value:Pick<ViewEntry,'kind'|'schemaVersion'|'representation'>){return this.registry.list(surface).flatMap(({value:entry})=>entry.surface===surface&&entry.entry.kind===value.kind&&entry.entry.schemaVersion===value.schemaVersion&&entry.entry.representation===value.representation?[entry.entry]:[]);}
  close(){return this.context.fiber.dispose();}
}
