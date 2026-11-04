import type {DelegatedQueryRuns} from '../delegated-query-runs.js';
import type {DelegationRuntime} from '../delegation-runtime.js';
import type {queryWithAttachmentsSchema} from '../query-request.js';

/** C27 query members. */
export interface QueryFeatureServices {
  delegation:DelegationRuntime;
  queryRuns:DelegatedQueryRuns;
  queryWithAttachmentsSchema:typeof queryWithAttachmentsSchema;
  jobId:(params:unknown)=>string;
}

export const queryFeatureServiceMembers = ['delegation','queryRuns','queryWithAttachmentsSchema','jobId'] as const satisfies readonly (keyof QueryFeatureServices)[];
