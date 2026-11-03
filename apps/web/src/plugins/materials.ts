import { builtinCollections } from '../features/collections';
import { pages } from '../features/materials';
import type { BuiltinWebPlugin } from './types';

export const materials: BuiltinWebPlugin = {
  id: 'mote.materials',
  pages: pages.filter(entry => entry.featureId === 'mote.materials'),
  collections: builtinCollections.filter(entry => entry.featureId === 'mote.materials'),
};
