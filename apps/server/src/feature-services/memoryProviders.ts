/** C23 provider adapters own no FeatureServices member. */
export interface MemoryProvidersFeatureServices {}

export const memoryProvidersFeatureServiceMembers = [] as const satisfies readonly (keyof MemoryProvidersFeatureServices)[];
