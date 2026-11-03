import {useContext, useEffect, useMemo} from 'react';
import {AgentAccessContext} from './context';
import {createAgentAccessController, type AgentAccessController} from './controller';
import type {Api} from '../../api';

/** The plugin page provides the factory-owned controller; a directly rendered
 * inspector (tests, embedded surfaces) starts and stops its own instance. */
export function useAgentAccess(api:Api): AgentAccessController {
  const context = useContext(AgentAccessContext);
  const standalone = useMemo(() => context ? undefined : createAgentAccessController(), [context,api]);
  useEffect(() => {
    if (!standalone) return;
    standalone.start();
    return () => standalone.stop();
  }, [standalone]);
  return context?.controller ?? standalone!;
}
