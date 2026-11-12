import type {BuiltinWebPlugin} from './types';

/** The official assistant package position. U10 reserves the package and its
 * navigation contributions; the owning feature cards add their pages and six
 * language strings here when each module is ready. An empty package mounts no
 * route and enables no work. */
export const assistant:BuiltinWebPlugin={id:'mote.assistant',pages:[]};
