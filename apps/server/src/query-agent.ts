import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';

/** Trusted declaration of which component owns the run's terminal accounting.
 * Only the leaf agent that actually executes a query declares it. */
export type AgentRunFinalizer='host'|'legacy';
/** Per-query lease. The executing leaf reports its own finalizer exactly once,
 * synchronously before any await; composites only forward it unchanged. */
export interface QueryRunLease{onFinalizer?(mode:AgentRunFinalizer):void}

/** Model adapter contract; independent of server assembly and HTTP transport. */
export interface QueryAgent {
  configured:boolean;
  configuredFor?(id:string):boolean;
  /** Declared by the leaf that owns accounting; composites never report. */
  runFinalizer?:AgentRunFinalizer;
  query(args:QueryInput,lease?:QueryRunLease):Promise<QueryResult>;
  close():Promise<void>;
}
