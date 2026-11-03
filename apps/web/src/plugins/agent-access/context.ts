import {createContext} from 'react';
import type {AgentAccessController} from './controller';

/** The plugin factory creates one route controller per authenticated Api. */
export interface AgentAccessPluginContextValue {
  readonly controller: AgentAccessController;
}

export const AgentAccessContext = createContext<AgentAccessPluginContextValue | null>(null);
