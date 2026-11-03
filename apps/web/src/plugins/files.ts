import { builtinCollections } from '../features/collections';
import type { BuiltinWebPlugin } from './types';

export const files: BuiltinWebPlugin = {
  id: 'mote.files',
  collections: builtinCollections.filter(entry => entry.featureId === 'mote.files'),
};
