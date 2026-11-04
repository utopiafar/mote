import type {MemoryPublication} from '../memory-publication.js';

/** C24 publication member. */
export interface PublicationFeatureServices {
  memoryPublication:MemoryPublication;
}

export const publicationFeatureServiceMembers = ['memoryPublication'] as const satisfies readonly (keyof PublicationFeatureServices)[];
