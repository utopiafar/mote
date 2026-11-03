import { builtinCollections } from '../features/collections';
import type { BuiltinWebPlugin } from './types';

export const memory: BuiltinWebPlugin = {
  id: 'mote.memory',
  collections: builtinCollections.filter(entry => entry.featureId === 'mote.memory'),
};
