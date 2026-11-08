import type {QueryInput,QueryRunLease} from '@mote/agent';
import type {QueryResult} from '@mote/shared';

/** The exact lease type published from the Agent package: the executing leaf
 * reports its own finalizer exactly once, synchronously before execution, and
 * composites only forward the same lease. */
export type {QueryRunLease};
/** Trusted declaration of which component owns the run's terminal accounting. */
export type AgentRunFinalizer='host';

/** Model adapter contract; independent of server assembly and HTTP transport. */
export interface QueryAgent {
  configured:boolean;
  configuredFor?(id:string):boolean;
  query(args:QueryInput,lease?:QueryRunLease):Promise<QueryResult>;
  close():Promise<void>;
}
