import {conversationMessageInputSchema, queryScopeSchema, type ConversationTaskStatus} from '@mote/shared';
import type {Api} from '../../api';
import {queryRecovery, type OwnedQuery} from './query-recovery';

export type ChatAttachment = {id: string; name: string; mimeType: string};
export type ChatImageUpload = {key: string; file: File; status: 'uploading' | 'failed'};
type Draft = {question: string; attachments: ChatAttachment[]};
export type ChatReadingPosition = {conversationId: string; atEnd: boolean; top: number; turnId?: string; offset?: number};
type Tab = {position?: ChatReadingPosition; supplement?: ConversationTaskStatus['task']};
export const unsentDrafts = new WeakMap<Api, Draft>();
export const unsentImages = new WeakMap<Api, ChatImageUpload[]>();
export const chatTabs = new WeakMap<Api, Tab>();
const scopes = new WeakMap<Api, string>();
const reloadKey = 'mote.chat-language-reload.v1';
const tabKey = 'mote.chat-tab.v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

function validDraft<T>(value: T): value is T & Draft {
  if (!value || typeof value !== 'object') return false;
  const saved = value as Partial<Draft>;
  return typeof saved.question === 'string' && saved.question.length <= 100000 &&
    Array.isArray(saved.attachments) && saved.attachments.length <= 4 &&
    saved.attachments.every(item => typeof item?.id === 'string' && uuid.test(item.id) &&
      typeof item.name === 'string' && item.name.length <= 1024 && ['image/png','image/jpeg','image/webp'].includes(item.mimeType));
}

/** This browser tab holds the private composer and reading position for its
 * authenticated view. File bytes, credentials and provider output stay out. */
export function associateChatScope(api: Api, scope: string | undefined) {
  if (!scope || scopes.get(api) === scope) return;
  scopes.set(api, scope);
  try {
    const tab = JSON.parse(sessionStorage.getItem(tabKey) ?? 'null');
    if (tab?.scope === scope) {
      if (tab.draft && validDraft(tab.draft)) unsentDrafts.set(api, tab.draft);
      const {position, supplement, pending, versions} = tab;
      const parsedScope = queryScopeSchema.safeParse(supplement?.scope);
      chatTabs.set(api, {
        ...(position && uuid.test(position.conversationId) && typeof position.atEnd === 'boolean' && Number.isFinite(position.top) &&
          (position.turnId === undefined || uuid.test(position.turnId) && Number.isFinite(position.offset)) ? {position} : {}),
        ...(supplement && uuid.test(supplement.id) && parsedScope.success && typeof supplement.goal === 'string' && supplement.goal.length <= 8000
          ? {supplement: {...supplement, scope: parsedScope.data}} : {}),
      });
      if (pending?.kind === 'owned' && typeof pending.body === 'string' && pending.body.length <= 65536 &&
          validDraft(pending) && validVersion(pending.draftVersion) && validVersion(pending.contextVersion) &&
          validVersion(versions?.draftVersion) && validVersion(versions?.contextVersion)) {
        const input = conversationMessageInputSchema.safeParse(JSON.parse(pending.body));
        if (input.success && input.data.clientRequestId === pending.id && input.data.conversationId === pending.conversationId &&
            input.data.question === pending.question) queryRecovery.restore(api, pending as OwnedQuery, versions);
      }
    } else if (tab) sessionStorage.removeItem(tabKey);
    const raw = sessionStorage.getItem(reloadKey);
    if (!raw) return;
    sessionStorage.removeItem(reloadKey);
    const saved = JSON.parse(raw);
    if (saved?.scope === scope && validDraft(saved)) unsentDrafts.set(api, {question:saved.question, attachments:saved.attachments});
  } catch { /* A storage error never prevents sign-in or a fresh chat. */ }
}

export function persistChatTab(api: Api) {
  const scope = scopes.get(api);
  if (!scope) return;
  try {
    const pending = queryRecovery.get(api);
    sessionStorage.setItem(tabKey, JSON.stringify({scope, draft:unsentDrafts.get(api), ...chatTabs.get(api),
      ...(pending?.kind === 'owned' ? {pending, versions:queryRecovery.versions(api)} : {})}));
  } catch { /* Keep the in-memory draft when storage is unavailable. */ }
}

export function preserveChatForLanguageReload(api: Api) {
  const draft = unsentDrafts.get(api);
  if (!draft || !draft.question && !draft.attachments.length) return true;
  const scope = scopes.get(api);
  if (!scope) return false;
  try {
    sessionStorage.setItem(reloadKey, JSON.stringify({scope, ...draft}));
    return true;
  } catch { return false; }
}

export function clearChatReloadDraft(api?: Api) {
  if (api) scopes.delete(api);
  try {sessionStorage.removeItem(reloadKey); sessionStorage.removeItem(tabKey);} catch {}
}
