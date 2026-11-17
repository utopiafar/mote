import type {FastifyInstance} from 'fastify';
import type {Context} from '@deepseek-ai/cordis';
import type {PluginResourceScope} from '@mote/plugin-host';
import type {FeatureRoute} from '../features/index.js';

/** A domain-owned HTTP contribution mounted once before listen. The contribution
 * dispatches against its current activation, so disabling and re-enabling the
 * owner never installs a second route table. */
export interface DomainRouteContribution {
  mount(app:FastifyInstance,scope?:PluginResourceScope):void;
}

/** Feature id -> route contribution. The trusted assembly provides this once on
 * the same root context as the plugin host. */
export type DomainRouteTable = Readonly<Record<string, DomainRouteContribution>>;

/** Project actual contributions in the pinned distribution's feature order.
 * This only mounts existing owners: their request guards and leased services
 * remain authoritative, including companion routes in the transitional table. */
export function collectSelectedFeatureRoutes(features:readonly string[],table:DomainRouteTable,activations:readonly FeatureRoute[],disposeAgentTools:(id:string)=>void|Promise<void>):readonly FeatureRoute[]{
  const selected=new Set<string>(),routes:FeatureRoute[]=[];
  for(const id of features){
    if(selected.has(id))continue;selected.add(id);
    const activated=activations.filter(route=>route.id===id);
    const parts:DomainRouteContribution[]=[...(Object.hasOwn(table,id)?[table[id]!]:[]),...activated];
    if(!parts.length)continue;
    const version=activated.find(route=>route.version!==undefined)?.version;
    routes.push(Object.freeze<FeatureRoute>({id,...(version!==undefined?{version}:{}),mount(app,scope){
      scope.defer(()=>disposeAgentTools(id));
      for(const part of parts)part.mount(app,scope);
    }}));
  }
  return Object.freeze(routes);
}

/** Several plugins may contribute routes to one feature (for example Ask owns
 * conversations and query receipts). Mount each contribution once in arrival
 * order without letting a later provider replace an earlier table. */
export function contributeDomainRoutes(context:Context,contributions:DomainRouteTable){
  const table=context.get('moteDomainRoutes')??{},merged:{[id:string]:DomainRouteContribution}={...table};
  for(const [id,contribution] of Object.entries(contributions)){
    const existing=merged[id];
    merged[id]=!existing||existing===contribution?contribution:Object.freeze({mount(app:FastifyInstance,scope?:PluginResourceScope){existing.mount(app,scope);contribution.mount(app,scope);}});
  }
  const frozen=Object.freeze(merged);
  if(context.get('moteDomainRoutes'))context.set('moteDomainRoutes',frozen);
  else context.provide('moteDomainRoutes',frozen);
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    moteDomainRoutes?: DomainRouteTable;
  }
}
