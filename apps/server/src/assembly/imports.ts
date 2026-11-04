import type {FastifyInstance} from 'fastify';
import type {Context} from '@deepseek-ai/cordis';
import type {ServerResources} from '../server-resources.js';
import type {FeatureServices} from '../feature-services.js';
import type {CentralDomainPlugin} from '../bootstrap.js';
import type {ServerFeatureScope} from '../feature-host.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {createImportServices,importServicesContribution,importServicesDeclaration,importServicesReplacement,type ImportServicesDependencies} from '../plugins/import-services.js';

export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:importServicesContribution,declaration:importServicesDeclaration,replacement:importServicesReplacement},
]);

export interface ImportsAssemblyDependencies extends ImportServicesDependencies {
  readonly resources:ServerResources;
  readonly backendContext:Context;
}

export function assembleImports(dependencies:ImportsAssemblyDependencies){
  const importServices=createImportServices(dependencies);
  dependencies.resources.defer(()=>importServices.close());
  importServices.prepare();importServices.start();
  contributeDomainRoutes(dependencies.backendContext,{'mote.imports':Object.freeze({mount:(app:FastifyInstance,_services?:FeatureServices,scope?:ServerFeatureScope)=>importServices.routes(app,scope)})});
  const {imports}=importServices;
  return Object.freeze({imports,importServices,featureServices:Object.freeze({}) satisfies Partial<FeatureServices>});
}
