import { sourceMaterialViews } from '../features/source-material';
import type { BuiltinWebPlugin } from './types';

export const sourceMaterialViewsPlugin: BuiltinWebPlugin = {
  id: 'mote.source-material-views',
  renderers: sourceMaterialViews,
};
