import type {SourcePipelineRuntime} from '../source-pipelines.js';

/** C09 source-runtime member. */
export interface SourceRuntimeFeatureServices {
  sourcePipelines:SourcePipelineRuntime;
}

export const sourceRuntimeFeatureServiceMembers = ['sourcePipelines'] as const satisfies readonly (keyof SourceRuntimeFeatureServices)[];
