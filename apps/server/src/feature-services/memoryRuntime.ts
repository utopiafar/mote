/** C22 Memory runtime exposes its capabilities through plugin ports. */
export interface MemoryRuntimeFeatureServices {}

export const memoryRuntimeFeatureServiceMembers = [] as const satisfies readonly (keyof MemoryRuntimeFeatureServices)[];
