/** C21B record storage owns no FeatureServices member. */
export interface MemoryRecordsFeatureServices {}

export const memoryRecordsFeatureServiceMembers = [] as const satisfies readonly (keyof MemoryRecordsFeatureServices)[];
