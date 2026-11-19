import type {CodingEvidence} from '@mote/shared';

const threadId=(value:unknown):value is string=>typeof value==='string'&&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Accept the native completed item, never a tool call, transcript or console echo. */
export function codexThreadLaunch(payload:any,sessionId:string):CodingEvidence['launch'] {
  const item=payload?.item;
  if(payload?.type!=='item_completed'||payload.thread_id!==sessionId||!threadId(payload.turn_id)||
    item?.type!=='McpToolCall'||item.server!=='codex_app'||item.pluginId!=='codex-app-tools@openai-bundled'||
    item.tool!=='create_thread'||item.status!=='completed')return;
  const result=item.result;
  if(result?.isError!==false||!Array.isArray(result.content)||result.content.length!==1)return;
  const [block]=result.content;
  if(block?.type!=='text'||typeof block.text!=='string'||block.text.length>1024)return;
  try{
    const reply=JSON.parse(block.text);
    if(threadId(reply?.threadId)&&reply.threadId!==sessionId&&typeof reply.hostId==='string'&&reply.hostId)
      return {childSessionId:reply.threadId,turnId:payload.turn_id};
  }catch{/* An unrecognized receipt supplies no relationship. */}
}

/** The explicit attachment and history cursor distinguish a side conversation
 * from an independent fork, and address only the history it actually saw. */
export function codexAttachedParent(payload:any,sessionId:string) {
  const id=payload?.forked_from_id,base=payload?.history_base,entry=base?.end_byte_offset;
  if(payload?.attached_thread!==true||!threadId(id)||id===sessionId||id!==base?.thread_id||!Number.isSafeInteger(entry)||entry<0)return;
  return {id,beforeEntry:entry as number};
}
