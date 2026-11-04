import type {ServerDiagnostics} from '../diagnostics.js';

/** C06 observability members. */
export interface ObservabilityFeatureServices {
  diagnostics:ServerDiagnostics;
  serverVersion:string;
}

export const observabilityFeatureServiceMembers = ['diagnostics','serverVersion'] as const satisfies readonly (keyof ObservabilityFeatureServices)[];
