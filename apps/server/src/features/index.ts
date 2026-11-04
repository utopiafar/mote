import {Context} from '@deepseek-ai/cordis';
import {FeatureRegistry,type FeatureManifest,type FeatureSurface} from '@mote/shared';
import type {FastifyInstance} from 'fastify';
import {collectorIngressWrite} from '../ingress.js';
import {PluginResourceScope} from '@mote/plugin-host';
import type {HostContributionDescriptor} from '../feature-inventory.js';

/** One selected feature's HTTP contribution. The route table is mounted once
 * before listen and dispatches against its domain activation on every request. */
export interface FeatureRoute {
  readonly id:string;
  readonly version?:string;
  readonly mount:(app:FastifyInstance,scope:FeatureScope)=>void;
}

export class FeatureScope extends PluginResourceScope {
  constructor(onError:(error:unknown)=>void=()=>{}){super(onError,'Feature disposal failed',true);}
}

/** Trusted, build-time HTTP feature contributions. The common PluginHost remains
 * authoritative for domain plugins; this table only mounts the selected HTTP
 * surfaces and projects the capabilities they actually registered. */
export class FeatureRoutes {
  readonly registry=new FeatureRegistry<unknown>();
  private installed=new Map<string,{fiber:{dispose():Promise<void>};closeScope:()=>Promise<void>|undefined}>();
  private disposals=new Map<string,Promise<void>>();
  private scopes=new Set<FeatureScope>();
  private closing?:Promise<void>;
  constructor(private root:Context,private app:FastifyInstance,private onError:(error:unknown)=>void=()=>{}){}
  contributions():HostContributionDescriptor[]{
    const inventory=this.registry.inventory();
    return inventory.features.map(feature=>({
      id:'feature:'+feature.id,version:feature.version,surface:'data',runtime:'host',
      featureId:feature.id,featureVersion:feature.version,self:false,state:inventory.capabilities.some(capability=>capability.featureId===feature.id&&capability.state==='active')?'active':'unavailable',
      components:inventory.capabilities.filter(capability=>capability.featureId===feature.id).map(({featureId:_featureId,state,reason,...component})=>({...component,state,...(reason?{reason}:{})})),
    }));
  }
  async install(route:FeatureRoute){
    if(this.closing)throw Error('Feature routes are closed');
    await this.disposals.get(route.id);this.disposals.delete(route.id);
    if(this.closing)throw Error('Feature routes are closed');
    const registry=this.registry,app=this.app,onError=this.onError;
    const manifest:FeatureManifest={id:route.id,version:route.version??'1',components:[]};
    let installedScope:FeatureScope|undefined;
    const fiber=this.root.plugin((ctx:Context)=>{
      ctx.effect(()=>registry.install(manifest,{completeTrustedTopology:true}));
      const scope=new FeatureScope(onError);installedScope=scope;ctx.effect(()=>{this.scopes.add(scope);return()=>{this.scopes.delete(scope);return scope.close();};});
      app.register(async child=>{
        child.addHook('onRequest',async(_req,reply)=>{if(!scope.active)return reply.code(503).send({error:'feature_unavailable'});});
        child.addHook('onRoute',route=>{
          for(const method of [route.method].flat()){
            const surface:FeatureSurface=collectorIngressWrite(method,route.url)?(route.url.startsWith('/api/file-sync/')?'upload':'ingress'):method==='GET'||method==='HEAD'?'data':'command';
            ctx.effect(()=>registry.register(manifest.id,{id:`http:${method}:${route.url}`,version:'1',surface},{method,path:route.url}));
          }
        });
        route.mount(child,scope);
      });
    });
    this.installed.set(route.id,{fiber,closeScope:()=>installedScope?.close()});
    try{await fiber;return fiber;}catch(error){try{await this.dispose(route.id);}catch(cleanup){throw new AggregateError([error,cleanup],'Feature initialization and disposal failed',{cause:error});}throw error;}
  }
  dispose(id:string){
    const previous=this.disposals.get(id);if(previous)return previous;
    const installed=this.installed.get(id);if(!installed)return Promise.resolve();this.installed.delete(id);
    const task=(async()=>{
      const errors:unknown[]=[];
      try{await installed.closeScope();}catch(error){errors.push(error);}
      try{await installed.fiber.dispose();}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'Feature disposal failed');
    })();
    this.disposals.set(id,task);return task;
  }
  stop(){for(const scope of this.scopes)scope.stop();}
  close(){return this.closing??=(async()=>{this.stop();const results=await Promise.allSettled([...new Set([...this.installed.keys(),...this.disposals.keys()])].map(id=>this.dispose(id)));const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Feature route disposal failed');})();}
}

export async function installFeatureRoutes(routes:FeatureRoutes,entries:readonly FeatureRoute[]){
  for(const route of entries)await routes.install(route);
}
