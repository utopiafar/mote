/** C25 actions member. Routes are contributed via moteDomainRoutes; no FeatureServices bridge. */
export interface ActionsFeatureServices {}

export const actionsFeatureServiceMembers = [] as const satisfies readonly (keyof ActionsFeatureServices)[];
