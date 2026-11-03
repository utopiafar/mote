import { builtinCollections } from '../features/collections';
import { pages } from '../features/materials';
import type { BuiltinWebPlugin } from './types';

export const coding: BuiltinWebPlugin = {
  id: 'mote.coding',
  pages: pages.filter(entry => entry.featureId === 'mote.coding'),
  collections: builtinCollections.filter(entry => entry.featureId === 'mote.coding'),
};
