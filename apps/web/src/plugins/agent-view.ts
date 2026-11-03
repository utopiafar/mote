import { homeEntries, pages } from '../features/agent-view';
import type { BuiltinWebPlugin } from './types';

export const agentView: BuiltinWebPlugin = { id: 'mote.agent-view', pages, home: homeEntries };
