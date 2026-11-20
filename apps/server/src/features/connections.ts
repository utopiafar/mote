import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {serverConfigSchema} from '../config.js';
import type {z} from 'zod';
import {connectorsConfigDomain} from '../config.js';
import type {ConnectionCredential,Connections} from '../connections.js';
import type {FeatureRoute} from './index.js';
import {randomUUID} from 'node:crypto';
import {serviceContract} from '@mote/plugin-api/contracts';
import type {ManifestContribution} from '@mote/plugin-api';
import type {bootstrapCentral,CentralDomainPlugin} from '../bootstrap.js';
import type {ServerResources} from '../server-resources.js';
import type {EvidenceStore as Store} from '../evidence-store.js';
import {registerConnectionServiceRoutes} from '../connection-services.js';

export interface ConnectionsFeatureDependencies {
  readonly config:Pick<z.output<typeof serverConfigSchema>,'profile'>;
  readonly connectors?:{readonly syncIntervalMs?:number};
  readonly connections:Connections;
  readonly connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly serverVersion:string;
  readonly store:Pick<Store,'db'>;
}

/** Credential and login transport owned by the authorization platform. */
export function connectionsFeature(dependencies:ConnectionsFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.connections',mount(app:FastifyInstance){
    dependencies.connections.routes(app,{serverVersion:dependencies.serverVersion,profile:dependencies.config.profile,identity:dependencies.connectionIdentity});
    registerConnectionServiceRoutes(app,{store:dependencies.store,connections:dependencies.connections,connectorConfig:dependencies.connectors});
  }});
}

/** Build-private transport input. The authorization platform continues to own
 * Connections, login handoffs and their request/credential checks. */
export const connectionsRouteInputContract=serviceContract<Pick<FeatureRoute,'mount'>>('mote.connections-route-input','1');
export const connectionsRouteInputContribution={id:'connections-route-input',version:'1.0.0',surface:'data',runtime:'host',
 provides:[{kind:'service',id:connectionsRouteInputContract.id,apiVersion:connectionsRouteInputContract.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const connectionsRouteInputDeclaration={id:connectionsRouteInputContribution.id,apiVersion:'1'} as const;
export const connectionsRoutesContribution={id:'connections-routes',version:'1.0.0',surface:'data',runtime:'host',
 requires:[{kind:'service',id:connectionsRouteInputContract.id,version:'1.0.0'}],provides:[],
} as const satisfies ManifestContribution;
export const connectionsRoutesDeclaration={id:connectionsRoutesContribution.id,apiVersion:'1'} as const;
export const connectionsRoutesPlugin=Object.freeze<CentralDomainPlugin>({
 contribution:connectionsRoutesContribution,declaration:connectionsRoutesDeclaration,replacement:'restart',
 activation:{featureId:'mote.connections',requires:{routes:{provider:connectionsRouteInputContribution.id,service:connectionsRouteInputContract}},async create(context,bindings){
  const input=await context.services.acquire(connectionsRouteInputContract,bindings.routes!);
  context.scope.defer(()=>input.release());
  return {route:{id:'mote.connections',mount(app,scope){input.assertCurrent();input.value.mount(app,scope);}},prepare(){input.assertCurrent();},start(){},quiesce(){},stop(){},dispose(){}};
 }},
});
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
 {contribution:connectionsRouteInputContribution,declaration:connectionsRouteInputDeclaration,replacement:'restart'},connectionsRoutesPlugin,
]);

/** Publish only when selected, before the common domain activation pass. No
 * second Connections instance or unselected route factory is constructed. */
export async function prepareConnectionsRoutes(bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>,resources:ServerResources,dependencies:Omit<ConnectionsFeatureDependencies,'store'|'connectors'>){
 if(!bootstrap.selectsFeature('mote.connections')||!bootstrap.selectsPlugin(connectionsRoutesContribution.id))return;
 if(!bootstrap.selectsPlugin(connectionsRouteInputContribution.id))throw Error('Selected Connections routes require their input provider');
 const handle=await bootstrap.host.install({
  identity:{host:bootstrap.host.identity,packageId:connectionsRouteInputContribution.id,installationId:'build:connections-route-input@1.0.0',instanceId:'connections-route-input',activationId:randomUUID()},
  contributions:[connectionsRouteInputDeclaration],restartRequired:true,
  factory(context){
   const route=connectionsFeature({...dependencies,store:bootstrap.store,connectors:bootstrap.configService.current(connectorsConfigDomain)});
   bootstrap.registerDomainService(context.provide(connectionsRouteInputContribution.id,connectionsRouteInputContract,route));
   return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
  },
 });
 resources.defer(()=>handle.close('shutdown'));
}
