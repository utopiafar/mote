import { builtinCollections } from '../features/collections';
import type { BuiltinWebPlugin } from './types';

export const capture: BuiltinWebPlugin = {
  id: 'mote.capture',
  collections: builtinCollections.filter(entry => entry.featureId === 'mote.capture'),
};
