import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {installAgentFeatures} from '../agent-feature-host.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';

/** A01-A17 Agent runtime members. */
export interface AgentFeatureServices {
  agent:AgentRuntimeRegistry;
  agentFeatures:Awaited<ReturnType<typeof installAgentFeatures>>;
  archiveReader:ContextReader;
  queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
}

export const agentFeatureServiceMembers = ['agent','agentFeatures','archiveReader','queryAgent'] as const satisfies readonly (keyof AgentFeatureServices)[];
