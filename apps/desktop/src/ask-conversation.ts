import {moteText} from '@mote/shared/i18n';
import type {AskConversation} from './ask';

/** Explicitly opened history keeps its identity; an ordinary Ask entry reads
 * the server's current main instead of guessing from recent activity. */
export async function resolveAskConversation(currentId:string|undefined,main:()=>Promise<{id:string}>):Promise<string>{
  return currentId??(await main()).id;
}

/** Keep older pages within the exact conversation and history revision. */
export function prependConversationTurns(current: AskConversation, older: AskConversation): AskConversation {
  if (older.id !== current.id || older.revision !== current.revision) throw Error(moteText('对话状态已变化，请重新读取后继续。'));
  const known = new Set(current.turns.map(turn => turn.id));
  return {...current, nextCursor: older.nextCursor, turns: [...older.turns.filter(turn => !known.has(turn.id)), ...current.turns]};
}

/** Re-read the exact turn; another turn citing the same record cannot authorize this one. */
export async function currentTurnCites(conversationId:string,turnId:string,evidenceId:string,load:(cursor?:string)=>Promise<AskConversation>,current:()=>boolean=()=>true):Promise<boolean> {
  let cursor:string|undefined,revision:number|undefined,first=true;const seen=new Set<string>();
  while(true){
    if(!current())return false;
    const page=await load(cursor);
    if(!current())return false;
    if(page.id!==conversationId||!first&&page.revision!==revision)throw Error(moteText('对话状态已变化，请重新读取后继续。'));
    if(first){revision=page.revision;first=false;}
    const turn=page.turns.find(item=>item.id===turnId);
    if(turn)return !turn.evidenceDeleted&&Boolean(turn.result?.citations.some(citation=>citation.id===evidenceId));
    if(!page.nextCursor)return false;
    if(seen.has(page.nextCursor))throw Error(moteText('对话状态已变化，请重新读取后继续。'));
    seen.add(page.nextCursor);cursor=page.nextCursor;
  }
}
