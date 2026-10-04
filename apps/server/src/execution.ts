import {executionEnvelope,type ExecutionEnvelope,type DomainExecutionInput} from '@mote/shared/execution';
export type ExecutionProjection={execution:ExecutionEnvelope};
/** Current domain-state projection for API responses. */
export function withExecution<T extends object>(value:T,input:DomainExecutionInput):T&ExecutionProjection{return {...value,execution:executionEnvelope(input)};}
