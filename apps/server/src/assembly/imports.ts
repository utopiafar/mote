import type {FastifyInstance} from 'fastify';
import type {ServerResources} from '../server-resources.js';
import type {FeatureServices} from '../feature-services.js';
import type {CentralDomainPlugin} from '../bootstrap.js';
import {createImportServices,importServicesContribution,importServicesDeclaration,importServicesReplacement,type ImportServicesDependencies} from '../plugins/import-services.js';

export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:importServicesContribution,declaration:importServicesDeclaration,replacement:importServicesReplacement},
]);

export interface ImportsAssemblyDependencies extends ImportServicesDependencies {
  readonly app:FastifyInstance;
  readonly resources:ServerResources;
}

export function assembleImports(dependencies:ImportsAssemblyDependencies){
  const importServices=createImportServices(dependencies);
  dependencies.resources.defer(()=>importServices.close());
  importServices.prepare();importServices.start();
  const {imports,importTasks,launchImport,launchOwnerImport}=importServices;
  return Object.freeze({imports,importTasks,launchImport,launchOwnerImport,importServices,featureServices:Object.freeze({imports,importTasks,launchImport,launchOwnerImport}) satisfies Partial<FeatureServices>});
}
