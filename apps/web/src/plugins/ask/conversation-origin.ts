import type {Answer,Api} from '../../api';
export interface OriginTurn {id:string;question:string;result?:Answer;evidenceDeleted?:boolean;evidenceStale?:boolean}
interface Page {id:string;revision?:number;turns:OriginTurn[];nextCursor?:string|null}
/** Resolve stable IDs through fresh authorized reads, including older pages. Never infer by text. */
export async function readOriginTurn(api:Api,conversationId:string,turnId:string,signal:AbortSignal){
 const path='/api/conversations/'+encodeURIComponent(conversationId);
 let page=await api.request<Page>(path,{signal});const revision=page.revision,seen=new Set<string>();
 while(true){
  if(page.id!==conversationId||page.revision!==revision)throw new Error('Conversation changed while reading its source');
  const turn=page.turns.find(turn=>turn.id===turnId);
  if(turn)return turn.evidenceDeleted?undefined:turn;
  if(!page.nextCursor)break;
  if(seen.has(page.nextCursor))throw new Error('Repeated conversation cursor');
  seen.add(page.nextCursor);page=await api.request<Page>(path+'?cursor='+encodeURIComponent(page.nextCursor),{signal});
 }
 // The stable turn anchor locates an older message directly, so inserts or
 // deletions elsewhere cannot move the page that contains it.
 const anchored=await api.request<Page>(path+'?limit=20&anchor='+encodeURIComponent(turnId),{signal});
 if(anchored.id!==conversationId)throw new Error('Conversation changed while reading its source');
 const turn=anchored.turns.find(turn=>turn.id===turnId);
 return turn?(turn.evidenceDeleted?undefined:turn):undefined;
}
export function conversationTurnRoute(conversationId:string,turnId:string){return '#/ask?'+new URLSearchParams({conversation:conversationId,turn:turnId});}
