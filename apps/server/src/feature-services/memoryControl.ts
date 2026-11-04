import type {MemoryIntegrationSettingsPort} from '../memory-integration-settings.js';
import type {MemoryRecipeSettingsPort} from '../memory-recipe-settings.js';
import type {MemoryStore} from '../memory.js';

/** C21A's strategy catalog and durable owner selections. */
export interface MemoryStrategySettingsFeature {
  readonly recipes:MemoryRecipeSettingsPort;
  readonly integration:MemoryIntegrationSettingsPort;
}

/** C21 Memory control members. */
export interface MemoryControlFeatureServices {
  memories:MemoryStore;
  memoryStrategySettings:MemoryStrategySettingsFeature;
}

export const memoryControlFeatureServiceMembers = ['memories','memoryStrategySettings'] as const satisfies readonly (keyof MemoryControlFeatureServices)[];
