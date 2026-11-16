import type {CentralDomainPlugin} from '../bootstrap.js';
import {activityServicesContribution,activityServicesDeclaration,activityServicesReplacement} from '../plugins/activity-services.js';
import {ownerQuestionServicesContribution,ownerQuestionServicesDeclaration,ownerQuestionServicesReplacement} from '../plugins/owner-question-services.js';

/** C26A/C26C's declared build-time domain plugins. The pre-H14 feature bridge
 * mounts the same route contributions until app.ts construction moves behind K04. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:activityServicesContribution,declaration:activityServicesDeclaration,replacement:activityServicesReplacement},
  {contribution:ownerQuestionServicesContribution,declaration:ownerQuestionServicesDeclaration,replacement:ownerQuestionServicesReplacement},
]);
