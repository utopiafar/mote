import { ownerQuestionPanels } from '../features/owner-questions';
import type { BuiltinWebPlugin } from './types';

export const ownerQuestions: BuiltinWebPlugin = {
  id: 'mote.owner-questions',
  panels: ownerQuestionPanels,
};
