import type {AgentProgress} from '@mote/agent';
import type {EvidenceDependencies,ExecutionEnvelope} from '@mote/shared';
export interface QueryRun {
  id:string;operationId?:string;status:'running'|'completed'|'failed'|'cancelled';createdAt:string;updatedAt:string;
  evidenceRevision?:number;conversationId?:string;turnId?:string;events:(AgentProgress&{at:string})[];
  evidenceDependencies?:EvidenceDependencies;
  error?:{code:string;message:string};availableAt?:number;
  execution?:ExecutionEnvelope;
}
