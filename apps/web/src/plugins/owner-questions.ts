import { ownerQuestionPanels } from '../features/owner-questions';
import type { BuiltinWebPlugin } from './types';

/** The pending list lives on Ideas; these exact host contexts stay. */
const pendingListPanels = new Set(['owner-questions.standalone-history', 'owner-questions.history']);

export const ownerQuestions: BuiltinWebPlugin = {
  id: 'mote.owner-questions',
  panels: ownerQuestionPanels.filter(panel => !pendingListPanels.has(panel.id)),
};
