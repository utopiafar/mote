import {randomUUID} from 'node:crypto';
import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {CentralDomainPlugin,DomainActivation} from '../domain-activation.js';
import type {bootstrapCentral} from '../bootstrap.js';
import type {ServerResources} from '../server-resources.js';
import {devicesFeature} from '../features/devices.js';
import {createDevicesSource,devicesSourceContribution,devicesSourceDeclaration,devicesSourceReplacement,type DeviceSourceOptions,type DeviceSourceDependencies,type DeviceRouteContext} from './devices-source.js';

/** One private constructor capability; raw repositories are never published. */
export type DevicesDomainFactory=(context:HostPluginContext)=>DomainActivation;
export const devicesFactoryContract=serviceContract<DevicesDomainFactory>('mote.central.devices-source-factory','1');
export const devicesFactoryContribution={id:'devices-source-factory',version:'1.0.0',surface:'data',runtime:'host',provides:[{kind:'service',id:devicesFactoryContract.id,apiVersion:'1',cardinality:'single'}]} as const satisfies ManifestContribution;
export const devicesFactoryDeclaration={id:devicesFactoryContribution.id,apiVersion:'1'} as const;

/** Opening, start and disposal all belong to the actual consumer activation. */
export function createDevicesDomainFactory(options:DeviceSourceOptions,dependencies:DeviceSourceDependencies,routeContext:DeviceRouteContext):DevicesDomainFactory {
 return context=>{
  const source=createDevicesSource(options,dependencies,context.scope),route=devicesFeature(source,routeContext);
  context.scope.defer(()=>source.close());
  return {route:{...route,mount(app,scope){route.mount(app,scope);scope.defer(()=>context.scope.cordis.fiber.dispose());}},prepare(){},start:()=>source.start(),quiesce:reason=>source.quiesce(reason),stop:reason=>source.stop(reason),dispose:()=>source.close()};
 };
}

export const devicesSourcePlugin=Object.freeze<CentralDomainPlugin>({
 contribution:devicesSourceContribution,declaration:devicesSourceDeclaration,replacement:devicesSourceReplacement,
 activation:{featureId:'mote.devices',requires:{factory:{provider:devicesFactoryContribution.id,service:devicesFactoryContract}},async create(context,bindings){
  const factory=await context.services.acquire(devicesFactoryContract,bindings.factory!);context.scope.defer(()=>factory.release());
  return factory.value(context);
 }},
});

/** Bind only the selected build's constructor; no source is opened here. */
export async function bindDevicesDomainFactory(bootstrap:Pick<Awaited<ReturnType<typeof bootstrapCentral>>,'host'|'registerDomainService'|'selectsPlugin'>,resources:ServerResources,factory:DevicesDomainFactory){
 if(!bootstrap.selectsPlugin(devicesFactoryContribution.id))throw Error('Devices source factory is not selected');
 const handle=await bootstrap.host.install({identity:{host:bootstrap.host.identity,packageId:devicesFactoryContribution.id,installationId:'build:devices-source-factory@1.0.0',instanceId:'devices-source-factory',activationId:randomUUID()},contributions:[devicesFactoryDeclaration],restartRequired:true,
  factory(context){bootstrap.registerDomainService(context.provide(devicesFactoryContribution.id,devicesFactoryContract,factory));return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};},
 });
 resources.defer(()=>handle.close('shutdown'));
}
