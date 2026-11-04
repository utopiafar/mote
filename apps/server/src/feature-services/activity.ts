import type {QueryInput} from '@mote/agent';
import type {InsightSnapshot} from '@mote/shared';
import type {InsightRuns} from '../insight-runs.js';
import type {insightResult} from '../insights.js';
import type {OwnerQuestions} from '../owner-questions.js';
import type {insightRequestSchema} from '../query-request.js';
import type {QueryScope} from '../query-scope.js';

/** C26 activity and insight members. */
export interface ActivityFeatureServices {
  insight:(range:QueryScope&{prompt?:string;modelProfileId?:string},onProgress?:QueryInput['onProgress'],signal?:AbortSignal,operationId?:string,snapshot?:InsightSnapshot)=>Promise<ReturnType<typeof insightResult>>;
  insightRuns:InsightRuns;
  insightRequestSchema:typeof insightRequestSchema;
  ownerQuestions:OwnerQuestions;
}

export const activityFeatureServiceMembers = ['insight','insightRuns','insightRequestSchema','ownerQuestions'] as const satisfies readonly (keyof ActivityFeatureServices)[];
