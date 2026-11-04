import type {MemoryIntegrationSettings} from '../memory-integration-settings.js';
import type {MemoryRecipeSettings} from '../memory-recipe-settings.js';
import type {MemoryStore} from '../memory.js';

/** C21 Memory control members. */
export interface MemoryControlFeatureServices {
  memories:MemoryStore;
  memoryIntegrationSettings:MemoryIntegrationSettings;
  memoryRecipeSettings:MemoryRecipeSettings;
}

export const memoryControlFeatureServiceMembers = ['memories','memoryIntegrationSettings','memoryRecipeSettings'] as const satisfies readonly (keyof MemoryControlFeatureServices)[];
