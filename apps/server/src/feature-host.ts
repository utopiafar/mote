import {Context} from '@deepseek-ai/cordis';
import {FeatureRegistry,type FeatureManifest,type FeatureSurface} from '@mote/shared';
import type {FastifyInstance} from 'fastify';
import {collectorIngressWrite} from './ingress.js';

/** Trusted, build-time server entries. HTTP topology changes require restart.
 * Cordis disposal revokes dispatch and registrations, never stored materials. */
export class ServerFeatureHost {
  readonly registry=new FeatureRegistry<unknown>();
  constructor(private root:Context,private app:FastifyInstance){}
  async install(manifest:FeatureManifest,entry:(app:FastifyInstance)=>void){
    const registry=this.registry,app=this.app;
    const fiber=this.root.plugin((ctx:Context)=>{
      ctx.effect(()=>registry.install(manifest));
      let active=true;ctx.effect(()=>()=>{active=false;});
      app.register(async child=>{
        child.addHook('onRequest',async(_req,reply)=>{if(!active)return reply.code(503).send({error:'feature_unavailable'});});
        child.addHook('onRoute',route=>{
          for(const method of [route.method].flat()){
            const surface:FeatureSurface=collectorIngressWrite(method,route.url)?(route.url.startsWith('/api/file-sync/')?'upload':'ingress'):method==='GET'||method==='HEAD'?'data':'command';
            ctx.effect(()=>registry.register(manifest.id,{id:`http:${method}:${route.url}`,version:'1',surface},{method,path:route.url}));
          }
        });
        entry(child);
      });
    });
    await fiber;return fiber;
  }
}
