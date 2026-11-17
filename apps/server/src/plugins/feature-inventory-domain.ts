import {randomUUID} from 'node:crypto';
import type {FeatureInventory} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract} from '@mote/plugin-api/contracts';
import type {CentralDomainPlugin,bootstrapCentral} from '../bootstrap.js';
import type {ServerResources} from '../server-resources.js';
import {inventoryFeature} from '../features/features.js';

/** Only a live projection function crosses this seam, never its registries. */
export const inventoryReaderContract=serviceContract<()=>FeatureInventory>('mote.central.feature-inventory-reader','1');
export const inventoryReaderContribution={id:'feature-inventory-reader',version:'1.0.0',surface:'data',runtime:'host',provides:[{kind:'service',id:inventoryReaderContract.id,apiVersion:'1',cardinality:'single'}]} as const satisfies ManifestContribution;
export const inventoryReaderDeclaration={id:inventoryReaderContribution.id,apiVersion:'1'} as const;
export const featureInventoryContribution={id:'feature-inventory',version:'1.0.0',surface:'data',runtime:'host',requires:[{kind:'service',id:inventoryReaderContract.id,version:'1.0.0'}]} as const satisfies ManifestContribution;
export const featureInventoryPlugin=Object.freeze<CentralDomainPlugin>({
 contribution:featureInventoryContribution,declaration:{id:featureInventoryContribution.id,apiVersion:'1'},replacement:'restart',
 activation:{featureId:'mote.features',requires:{reader:{provider:inventoryReaderContribution.id,service:inventoryReaderContract}},async create(context,bindings){
  const reader=await context.services.acquire(inventoryReaderContract,bindings.reader!);context.scope.defer(()=>reader.release());
  return {route:inventoryFeature(()=>{reader.assertCurrent();return reader.value();}),prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
 }},
});
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
 {contribution:inventoryReaderContribution,declaration:inventoryReaderDeclaration,replacement:'restart'},featureInventoryPlugin,
]);

/** The existing platform assembly binds the selected build's dynamic facts. */
export async function prepareFeatureInventory(bootstrap:Pick<Awaited<ReturnType<typeof bootstrapCentral>>,'host'|'selectsFeature'|'selectsPlugin'|'registerDomainService'>,resources:ServerResources,read:()=>FeatureInventory){
 if(!bootstrap.selectsFeature('mote.features')||!bootstrap.selectsPlugin(featureInventoryContribution.id))return;
 if(!bootstrap.selectsPlugin(inventoryReaderContribution.id))throw Error('Feature inventory reader is not selected');
 const handle=await bootstrap.host.install({identity:{host:bootstrap.host.identity,packageId:inventoryReaderContribution.id,installationId:'build:feature-inventory-reader@1.0.0',instanceId:'feature-inventory-reader',activationId:randomUUID()},contributions:[inventoryReaderDeclaration],restartRequired:true,
  factory(context){bootstrap.registerDomainService(context.provide(inventoryReaderContribution.id,inventoryReaderContract,read));return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};},
 });
 resources.defer(()=>handle.close('shutdown'));
}
