import type {Config} from '../config.js';
import type {ConfigService} from '../config-service.js';
import type {ExecutionSettings} from '../execution-settings.js';
import type {ModelSettingsStore} from '../model-settings.js';

/** C03 configuration members. */
export interface ConfigurationFeatureServices {
  configService:ConfigService;
  runtimeSettings:ExecutionSettings;
  modelSettings:ModelSettingsStore;
  config:Config;
}

export const configurationFeatureServiceMembers = ['configService','runtimeSettings','modelSettings','config'] as const satisfies readonly (keyof ConfigurationFeatureServices)[];
