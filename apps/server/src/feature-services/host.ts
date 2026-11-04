import type {FeatureInventory} from '@mote/shared';

/** H04/H05/H14 host member. */
export interface HostFeatureServices {
  isClosing:()=>boolean;
  featureInventory:()=>FeatureInventory;
}

export const hostFeatureServiceMembers = ['isClosing','featureInventory'] as const satisfies readonly (keyof HostFeatureServices)[];
