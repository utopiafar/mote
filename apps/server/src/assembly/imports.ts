import type {FastifyInstance} from 'fastify';
import type {ServerResources} from '../server-resources.js';
import type {FeatureServices} from '../feature-services.js';
import type {CentralDomainPlugin} from '../bootstrap.js';
import {createAgentImportHost} from '../agent-import-host.js';
import {createImportServices,importServicesContribution,importServicesDeclaration,importServicesReplacement,type ImportServicesDependencies} from '../plugins/import-services.js';

export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:importServicesContribution,declaration:importServicesDeclaration,replacement:importServicesReplacement},
]);

export interface ImportsAssemblyDependencies extends ImportServicesDependencies {
  readonly app:FastifyInstance;
  readonly resources:ServerResources;
}

export function assembleImports(dependencies:ImportsAssemblyDependencies){
  const importHost=createAgentImportHost(dependencies);
  const importServices=createImportServices(dependencies,importHost);
  dependencies.resources.defer(async()=>{
    const errors:unknown[]=[];
    try{await importServices.close();}catch(error){errors.push(error);}
    try{await importHost.close();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Import assembly disposal failed');
  });
  importServices.prepare();importServices.start();
  const {imports,importTasks,launchImport,launchOwnerImport}=importServices;
  return Object.freeze({imports,importTasks,launchImport,launchOwnerImport,importServices,featureServices:Object.freeze({imports,importTasks,launchImport,launchOwnerImport}) satisfies Partial<FeatureServices>});
}
