import { pages } from '../features/processing';
import type { BuiltinWebPlugin } from './types';

export const processing: BuiltinWebPlugin = {
  id: 'mote.processing',
  pages: pages.filter(entry => entry.featureId === 'mote.processing'),
};
