import { pages } from '../features/materials';
import type { BuiltinWebPlugin } from './types';

export const coding: BuiltinWebPlugin = {
  id: 'mote.coding',
  pages: pages.filter(entry => entry.featureId === 'mote.coding'),
};
