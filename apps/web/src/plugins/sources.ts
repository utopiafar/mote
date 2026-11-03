import { builtinCollections } from '../features/collections';
import { pages } from '../features/sources';
import type { BuiltinWebPlugin } from './types';

export const sources: BuiltinWebPlugin = {
  id: 'mote.sources',
  pages,
  collections: builtinCollections.filter(entry => entry.featureId === 'mote.sources'),
};
