import type {Api} from '../../api';
export type ChatAttachment={id:string;name:string;mimeType:string};
export type ChatImageUpload={key:string;file:File;status:'uploading'|'failed'};
export const unsentDrafts=new WeakMap<Api,{question:string;attachments:ChatAttachment[]}>();
// Pending files remain in memory only, scoped to the authenticated API.
export const unsentImages=new WeakMap<Api,ChatImageUpload[]>();
const scopes=new WeakMap<Api,string>(),reloadKey='mote.chat-language-reload.v1';
/** One-shot bridge only for the owner's explicit language reload. It contains
 * no credential and restores only into the same persisted browser view scope. */
export function associateChatScope(api:Api,scope:string|undefined){if(!scope)return;scopes.set(api,scope);try{const raw=sessionStorage.getItem(reloadKey);if(!raw)return;sessionStorage.removeItem(reloadKey);const saved=JSON.parse(raw);if(saved.scope===scope&&typeof saved.question==='string'&&saved.question.length<=100000&&Array.isArray(saved.attachments)&&saved.attachments.length<=4&&saved.attachments.every((item:ChatAttachment)=>typeof item.id==='string'&&/^[a-f0-9-]{36}$/i.test(item.id)&&typeof item.name==='string'&&item.name.length<=1024&&['image/png','image/jpeg','image/webp'].includes(item.mimeType)))unsentDrafts.set(api,{question:saved.question,attachments:saved.attachments});}catch{/* A failed bridge never widens a session or blocks sign-in. */}}
export function preserveChatForLanguageReload(api:Api){const draft=unsentDrafts.get(api);if(!draft||!draft.question&&!draft.attachments.length)return true;const scope=scopes.get(api);if(!scope)return false;try{sessionStorage.setItem(reloadKey,JSON.stringify({scope,...draft}));return true;}catch{return false;}}
export function clearChatReloadDraft(){try{sessionStorage.removeItem(reloadKey);}catch{}}
