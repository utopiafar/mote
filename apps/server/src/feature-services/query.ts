/** C27 query members. Delegation and query runs are owned by the Ask plugin (ASK02). */
export interface QueryFeatureServices {
  jobId:(params:unknown)=>string;
}

export const queryFeatureServiceMembers = ['jobId'] as const satisfies readonly (keyof QueryFeatureServices)[];
