import {Context} from '@deepseek-ai/cordis';
import {FeatureRegistry,type FeatureManifest,type FeatureSurface} from '@mote/shared';
import type {FastifyInstance} from 'fastify';
import {collectorIngressWrite} from './ingress.js';

export class ServerFeatureScope {
  private disposers:Array<()=>unknown|Promise<unknown>>=[];
  private timers=new Set<ReturnType<typeof setInterval>>();
  private pending=new Set<Promise<unknown>>();
  active=true;
  constructor(private onError:(error:unknown)=>void=()=>{}){}
  run(work:()=>unknown|Promise<unknown>){
    if(!this.active)return Promise.resolve();
    const task=Promise.resolve().then(()=>this.active?work():undefined);this.pending.add(task);
    void task.catch(error=>this.onError(error)).finally(()=>this.pending.delete(task));return task;
  }
  defer(dispose:()=>unknown|Promise<unknown>){if(!this.active)throw Error('Feature is closed');this.disposers.push(dispose);}
  every(ms:number,work:()=>unknown|Promise<unknown>){
    let running=false;
    const timer=setInterval(()=>{if(!this.active||running)return;running=true;void this.run(work).catch(()=>{}).finally(()=>{running=false;});},ms);
    timer.unref();this.timers.add(timer);
  }
  async close(){if(!this.active)return;this.active=false;for(const timer of this.timers)clearInterval(timer);this.timers.clear();
    const closed=await Promise.allSettled(this.disposers.reverse().map(dispose=>Promise.resolve().then(dispose)));
    await Promise.allSettled([...this.pending]);
    const errors=closed.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Feature disposal failed');
  }
}

/** Trusted, build-time server entries. HTTP topology changes require restart.
 * Cordis disposal revokes dispatch and registrations, never stored materials. */
export class ServerFeatureHost {
  readonly registry=new FeatureRegistry<unknown>();
  private installed=new Map<string,{dispose():Promise<void>}>();
  constructor(private root:Context,private app:FastifyInstance,private onError:(error:unknown)=>void=()=>{}){}
  async install(manifest:FeatureManifest,entry:(app:FastifyInstance,scope:ServerFeatureScope)=>void){
    const registry=this.registry,app=this.app,onError=this.onError;
    const fiber=this.root.plugin((ctx:Context)=>{
      ctx.effect(()=>registry.install(manifest));
      const scope=new ServerFeatureScope(onError);ctx.effect(()=>()=>scope.close());
      app.register(async child=>{
        child.addHook('onRequest',async(_req,reply)=>{if(!scope.active)return reply.code(503).send({error:'feature_unavailable'});});
        child.addHook('onRoute',route=>{
          for(const method of [route.method].flat()){
            const surface:FeatureSurface=collectorIngressWrite(method,route.url)?(route.url.startsWith('/api/file-sync/')?'upload':'ingress'):method==='GET'||method==='HEAD'?'data':'command';
            ctx.effect(()=>registry.register(manifest.id,{id:`http:${method}:${route.url}`,version:'1',surface},{method,path:route.url}));
          }
        });
        entry(child,scope);
      });
    });
    try{await fiber;this.installed.set(manifest.id,fiber);return fiber;}catch(error){await fiber.dispose();throw error;}
  }
  async dispose(id:string){const fiber=this.installed.get(id);if(fiber){this.installed.delete(id);await fiber.dispose();}}
  async close(){await Promise.all([...this.installed.keys()].map(id=>this.dispose(id)));}

}
