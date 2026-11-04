/** H04/H05/H14 host member. */
export interface HostFeatureServices {
  isClosing:()=>boolean;
}

export const hostFeatureServiceMembers = ['isClosing'] as const satisfies readonly (keyof HostFeatureServices)[];
