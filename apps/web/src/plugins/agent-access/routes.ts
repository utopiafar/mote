import {pageHash, pageRoutes} from '@mote/shared';

export const aiAccessRoute = pageRoutes.connections + '/access';
export const agentInspectorRoute = aiAccessRoute + '/agent';

export function aiAccessHref(connection?: string) {
  return '#/' + aiAccessRoute + (connection ? '?' + new URLSearchParams({connection}) : '');
}

export function agentInspectorHref(trace = false) {
  return '#/' + agentInspectorRoute + (trace ? '?tab=input' : '');
}

export const connectionsHref = pageHash('connections');
