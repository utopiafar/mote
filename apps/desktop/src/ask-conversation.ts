import {moteText} from '@mote/shared/i18n';
import type {AskConversation} from './ask';

/** Keep older pages within the exact conversation and history revision. */
export function prependConversationTurns(current: AskConversation, older: AskConversation): AskConversation {
  if (older.id !== current.id || older.revision !== current.revision) throw Error(moteText('对话状态已变化，请重新读取后继续。'));
  const known = new Set(current.turns.map(turn => turn.id));
  return {...current, nextCursor: older.nextCursor, turns: [...older.turns.filter(turn => !known.has(turn.id)), ...current.turns]};
}
