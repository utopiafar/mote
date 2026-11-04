import type {FeatureInventory} from '@mote/shared';
import type {HostContributionDescriptor} from '../feature-inventory.js';

/** H04/H05/H14 host member. */
export interface HostFeatureServices {
  isClosing:()=>boolean;
  featureInventory:(extra?:readonly HostContributionDescriptor[])=>FeatureInventory;
}

export const hostFeatureServiceMembers = ['isClosing','featureInventory'] as const satisfies readonly (keyof HostFeatureServices)[];
