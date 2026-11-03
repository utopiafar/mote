import { builtinCollections } from '../features/collections';
import type { BuiltinWebPlugin } from './types';

export const media: BuiltinWebPlugin = {
  id: 'mote.media',
  collections: builtinCollections.filter(entry => entry.featureId === 'mote.media'),
};
