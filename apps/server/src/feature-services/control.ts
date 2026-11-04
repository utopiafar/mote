import type {PluginCenter} from '../plugin-center.js';

/** C07/C08 plugin-control member. */
export interface ControlFeatureServices {
  pluginCenter:PluginCenter;
}

export const controlFeatureServiceMembers = ['pluginCenter'] as const satisfies readonly (keyof ControlFeatureServices)[];
