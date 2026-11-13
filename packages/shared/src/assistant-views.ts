import type {QueryScope} from './query-scope.js';
import type {OperationState} from './operations.js';
import type {EvidenceDependencies} from './evidence-dependencies.js';
import type {SourceContextDeclaration} from './material-context.js';

/** Browser projections of the existing assistant domain objects. These names
 * and fields mirror the domain services; they confer no evidence permission. */
export type MatterState='active'|'paused'|'archived';
export type Matter={id:string;goal:string;scope:QueryScope;state:MatterState;revision:number;taskIds:string[];evidenceIds:string[];
 correction:string|null;createdAt:string;updatedAt:string;archivedAt:string|null};
export type MatterEvidenceView={id:string;title:string;sourceId?:string;deviceId?:string;at:string};
export type MatterTaskView={id:string;state:OperationState;revision:number;updatedAt:string};
export type MatterDetail={matter:Matter;linkedTasks:MatterTaskView[];linkedEvidence:MatterEvidenceView[];coverage:{tasks:'complete'|'partial';evidence:'complete'|'partial'}};
export type RoutineTrigger={kind:'daily';localTime:string}|{kind:'weekly';weekday:number;localTime:string}|{kind:'before-event';leadMinutes:number};
export type RoutineSchedule={revision:number;timeZone:string;trigger:RoutineTrigger};
export type Routine={id:string;revision:number;enabled:boolean;nextDue:string|null;goal:string;scope:QueryScope;schedule:RoutineSchedule;
 matterId:string|null;event:{sourceId:string;externalId:string}|null};
export type CommitmentStatus='pending_confirmation'|'confirmed'|'completed'|'cancelled';
export type CommitmentChanges={title?:string;status?:CommitmentStatus;deadline?:{text:string;at:string|null}|null;
 matterId?:string|null;personMemoryId?:string|null;todoId?:string|null};
export type CommitmentEvent={commitmentId:string;eventId:string;occurredAt:string|null;summary:string;
 evidence:{id:string;offset:number;quote:string;ref?:string}[];evidenceDependencies:EvidenceDependencies;sourceContextDependencies?:SourceContextDeclaration[];
 changes:CommitmentChanges;origin:'proposal'|'owner';kind?:'commitment'|'progress'|'status'|'reminder';targetEventId?:string;createdAt:string};
export type Commitment={id:string;revision:number;title:string;status:CommitmentStatus;deadline?:{text:string;at:string|null}|null;
 dueState:'none'|'unknown'|'closed'|'overdue'|'upcoming';matterId:string|null;personMemoryId:string|null;todoId:string|null;
 timeline:CommitmentEvent[];evidenceDependencies:EvidenceDependencies;sourceContextDependencies:SourceContextDeclaration[];createdAt:string;updatedAt:string};
