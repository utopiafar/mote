import {moteText} from '@mote/shared/i18n';
import {ApiError,type Api} from '../../api';

/** The product conversation queue persists the owner's exact input before a
 * model run starts. These states are the server's facts, not client guesses. */
export type ConversationMessageState='accepted'|'queued'|'running'|'completed'|'failed'|'cancelled';
export interface ConversationMessageScope {
  kind:'all'|'selection';
  after?:string;
  before?:string;
  deviceId?:string;
  timeZone?:string;
  evidenceIds?:string[];
  sourceIds?:string[];
}
export interface ConversationMessage {
  id:string;
  conversationId:string;
  clientRequestId:string;
  seq:number;
  question:string;
  scope:ConversationMessageScope;
  revision:number;
  status:ConversationMessageState;
  createdAt:string;
  runId?:string;
  modelProfileId?:string;
  modelOverride?:string;
  attachmentIds?:string[];
  anchorEvidenceIds?:string[];
  anchorMaterialRef?:string;
  error?:{code?:string;message:string};
}
export type ConversationMessageInput={
  conversationId:string;
  clientRequestId:string;
  question:string;
  scope:ConversationMessageScope;
  attachmentIds?:string[];
  anchorEvidenceIds?:string[];
  anchorMaterialRef?:string;
  modelProfileId?:string;
  modelOverride?:string;
};

export function pendingMessageStatus(status:ConversationMessageState):boolean{
  return status==='accepted'||status==='queued'||status==='running';
}

export function messageStateLabel(status:ConversationMessageState):string{
  switch(status){
    case 'accepted':return moteText('已接收');
    case 'queued':return moteText('排队等待回答');
    case 'running':return moteText('正在回答');
    case 'completed':return moteText('回答已归档');
    case 'failed':return moteText('这次回答没有完成');
    case 'cancelled':return moteText('已停止');
  }
}

function validReceipt(value:unknown,input:ConversationMessageInput):value is ConversationMessage{
  if(!value||typeof value!=='object')return false;
  const message=value as Partial<ConversationMessage>;
  return typeof message.id==='string'
    &&message.conversationId===input.conversationId
    &&message.clientRequestId===input.clientRequestId
    &&typeof message.seq==='number'
    &&['accepted','queued','running','completed','failed','cancelled'].includes(String(message.status))
    &&typeof message.createdAt==='string';
}

/** POST is idempotent by clientRequestId. A lost acknowledgement is retried with
 * the exact same bytes; a malformed positive response stays unconfirmed. */
export async function admitConversationMessage(api:Api,input:ConversationMessageInput,signal:AbortSignal):Promise<ConversationMessage>{
  const body=JSON.stringify(input),accepted=await api.request<unknown>('/api/conversations/messages',{method:'POST',body,signal});
  if(!validReceipt(accepted,input))throw Error(moteText('中央响应格式无效，请刷新后重试。'));
  return accepted;
}

export async function readConversationMessage(api:Api,conversationId:string,id:string,signal:AbortSignal):Promise<ConversationMessage>{
  const value=await api.request<ConversationMessage>(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(id)}`,{signal});
  if(!value||value.conversationId!==conversationId)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
  return value;
}

export function definiteAdmissionFailure(error:unknown):boolean{
  return error instanceof ApiError&&[400,401,403,404,409,410,413,422].includes(error.status);
}
