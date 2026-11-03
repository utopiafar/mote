import { pages } from '../features/processing';
import type { BuiltinWebPlugin } from './types';

export const activity: BuiltinWebPlugin = {
  id: 'mote.activity',
  pages: pages.filter(entry => entry.featureId === 'mote.activity'),
};
