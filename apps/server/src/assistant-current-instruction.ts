import type {ConversationMessage} from './conversations.js';
import {conversationInputIdentity} from './conversations.js';
import type {ModelConnection} from './background-model-authorization.js';
import {sha256} from './store.js';

/** Host-only origin in the existing encrypted Task input. This is owner text,
 * not a capture, retrieval record, citation, source grant or Action authority. */
export type CurrentInstructionOrigin={inputHash:string;text:string;modelProfileId:string;modelOverride:string;connection:ModelConnection};
export type CurrentInstructionModel=Pick<CurrentInstructionOrigin,'modelProfileId'|'modelOverride'|'connection'>;
export const currentInstructionHash=(message:ConversationMessage)=>sha256(JSON.stringify(conversationInputIdentity(message)));
export function currentInstructionRequestId(message:ConversationMessage){
 const h=sha256(JSON.stringify(['assistant.current-instruction',message.conversationId,message.id,currentInstructionHash(message)]));
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
