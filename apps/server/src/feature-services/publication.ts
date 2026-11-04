/** C24 publication owns its ports and no FeatureServices member. */
export interface PublicationFeatureServices {}

export const publicationFeatureServiceMembers = [] as const satisfies readonly (keyof PublicationFeatureServices)[];
