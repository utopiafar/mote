import type {AgentProgress} from '@mote/agent';
import type {EvidenceDependencies,ExecutionEnvelope,SourceContextDeclaration} from '@mote/shared';
export interface QueryRun {
  id:string;operationId?:string;status:'running'|'completed'|'failed'|'cancelled';createdAt:string;updatedAt:string;
  evidenceRevision?:number;conversationId?:string;turnId?:string;events:(AgentProgress&{at:string})[];
  evidenceDependencies?:EvidenceDependencies;
  sourceContextDependencies?:SourceContextDeclaration[];
  error?:{code:string;message:string;reason?:string;diagnostic?:import('@mote/shared').FailureDiagnostics};availableAt?:number;
  execution?:ExecutionEnvelope;
  operationUsage?:import('./usage.js').OperationUsage;
}
