import type {FileProcessing} from '../file-processing.js';
import type {modelConfiguration} from '../model-configuration.js';
import type {ProcessingRuntime} from '../processing-runtime.js';

/** C17 processing members. */
export interface ProcessingFeatureServices {
  processing:FileProcessing;
  workflows:ProcessingRuntime;
  semanticSelection:()=>ReturnType<typeof modelConfiguration>&{configured:boolean};
}

export const processingFeatureServiceMembers = ['processing','workflows','semanticSelection'] as const satisfies readonly (keyof ProcessingFeatureServices)[];
