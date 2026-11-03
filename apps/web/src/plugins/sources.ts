import { pages } from '../features/sources';
import type { BuiltinWebPlugin } from './types';

export const sources: BuiltinWebPlugin = {
  id: 'mote.sources',
  pages,
};
