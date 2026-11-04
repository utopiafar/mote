import type {ActionsServicesAssembly} from '../plugins/actions-services.js';

/** C25 actions member. */
export interface ActionsFeatureServices {
  actionsServices:ActionsServicesAssembly;
}

export const actionsFeatureServiceMembers = ['actionsServices'] as const satisfies readonly (keyof ActionsFeatureServices)[];
