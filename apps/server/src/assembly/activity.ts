import type {CentralDomainPlugin} from '../bootstrap.js';
import {insightServicesContribution,insightServicesDeclaration,insightServicesReplacement} from '../plugins/insight-services.js';

/** C26B's declared build-time domain plugin. The pre-H14 feature bridge mounts
 * the same route contribution until app.ts construction moves behind K04. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:insightServicesContribution,declaration:insightServicesDeclaration,replacement:insightServicesReplacement},
]);
