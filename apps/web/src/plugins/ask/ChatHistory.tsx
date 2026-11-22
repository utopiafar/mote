import {useEffect, useRef, useState} from 'react';
import {Search} from 'lucide-react';
import {getLocale, moteText} from '@mote/shared/i18n';
import {ApiError, dateTime, type Answer, type Api} from '../../api';
import {Loading} from '../../Loading';
import {ConversationDialog} from './ConversationTurnDetails';
import type {ChatAttachment} from './chat-drafts';
import type {ConversationMessage, ConversationMessageInput, ConversationMessageScope} from './conversation-messages';

export type ChatScope = Partial<ConversationMessageScope> & Pick<ConversationMessageInput, 'anchorEvidenceIds' | 'anchorMaterialRef'>;
export type ChatTurn = Pick<ConversationMessage, 'id' | 'question' | 'status' | 'createdAt' | 'runId' | 'error' |
  'modelProfileId' | 'modelOverride' | 'steering' | 'taskSteering' | 'amendedBy' | 'supersededBy'> & {
  seq?: number;
  version?: number;
  scope?: ChatScope;
  result?: Answer;
  evidenceDeleted?: boolean;
  evidenceStale?: boolean;
  evidenceUnavailable?: boolean;
  attachments?: ChatAttachment[];
};
export type ChatPage = {id: string; scope: ChatScope; revision?: number; turns: ChatTurn[]; nextCursor?: string | null};

export const chatPath = (id: string) => '/api/conversations/' + encodeURIComponent(id);
export const chatRevoked = (error: unknown) => error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
export const hiddenAnswer = (turn: ChatTurn) => turn.evidenceDeleted || turn.evidenceStale;
export const samePage = (head: ChatPage | undefined, page: ChatPage | undefined) =>
  Boolean(head && page && head.id === page.id && head.revision === page.revision);

export class ChatRevisionChanged extends Error {}

export async function readChatPage(api: Api, head: ChatPage, query: URLSearchParams, signal: AbortSignal) {
  const page = await api.request<ChatPage>(chatPath(head.id) + '?' + query, {signal});
  signal.throwIfAborted();
  if (!samePage(head, page)) throw new ChatRevisionChanged();
  return page;
}

export function mergeChatPages(older: ChatPage, newer: ChatPage): ChatPage {
  const ids = new Set(newer.turns.map(turn => turn.id));
  return {...newer, turns: [...older.turns.filter(turn => !ids.has(turn.id)), ...newer.turns], nextCursor: older.nextCursor};
}

type Hit = {turn: ChatTurn; excerpt: string};
type SearchResult = {head: ChatPage; hits: Hit[]; page: ChatPage};
const resultLimit = 20;

async function findMessages(api: Api, head: ChatPage, query: string, signal: AbortSignal): Promise<SearchResult> {
  const needle = query.toLocaleLowerCase(getLocale());
  const hits: Hit[] = [];
  const pages = [head];
  const cursors = new Set<string>();
  let page = head;
  for (;;) {
    for (const turn of [...page.turns].reverse()) {
      const text = [turn.question, hiddenAnswer(turn) ? undefined : turn.result?.answer]
        .find(value => value?.toLocaleLowerCase(getLocale()).includes(needle));
      if (!text) continue;
      const match = text.toLocaleLowerCase(getLocale()).indexOf(needle);
      hits.push({turn, excerpt: text.slice(Math.max(0, match - 30), match + needle.length + 70)});
      if (hits.length === resultLimit) break;
    }
    const cursor = page.nextCursor;
    if (hits.length === resultLimit || !cursor) break;
    if (cursors.has(cursor)) throw new Error('Repeated conversation cursor');
    cursors.add(cursor);
    page = await readChatPage(api, head, new URLSearchParams({cursor}), signal);
    pages.push(page);
  }
  const visited = new Set<string>();
  const turns = pages.reverse().flatMap(({turns}) => turns.filter(turn => {
    if (visited.has(turn.id)) return false;
    visited.add(turn.id);
    return true;
  }));
  return {head, hits, page: {...head, turns, nextCursor: page.nextCursor}};
}

export function ChatSearch({api, head, onSelect, onInvalidated}: {
  api: Api;
  head: ChatPage | undefined;
  onSelect: (turnId: string, page: ChatPage) => void;
  onInvalidated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [result, setResult] = useState<SearchResult>();
  const request = useRef<AbortController | undefined>(undefined);
  const currentHead = useRef(head);
  currentHead.current = head;
  const current = samePage(result?.head, head) ? result : undefined;

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
  }, [head?.id, head?.revision]);

  function reset() {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
    setFailed(false);
    setResult(undefined);
  }

  async function search() {
    const term = query.trim();
    if (!head || !term) return;
    reset();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await findMessages(api, head, term, controller.signal);
      if (!controller.signal.aborted && samePage(head, currentHead.current)) setResult(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      setFailed(true);
      if (error instanceof ChatRevisionChanged || chatRevoked(error)) onInvalidated();
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }

  function close() {
    reset();
    setQuery('');
    setOpen(false);
  }

  return <>
    <button type="button" className="icon-button chat-search-toggle" aria-label={moteText('搜索聊天')}
      aria-haspopup="dialog" disabled={!head?.turns.length} onClick={() => setOpen(true)}><Search size={18}/></button>
    <ConversationDialog open={open} title={moteText('搜索聊天')} onClose={close}>
      {open && <>
        <form className="chat-search-form" onSubmit={event => {event.preventDefault(); void search();}}>
          <input type="search" aria-label={moteText('搜索聊天')} value={query} maxLength={200}
            onChange={event => {setQuery(event.target.value); reset();}}/>
          <button type="submit" className="button" disabled={!query.trim() || !head || busy}>
            {failed || result && !current ? moteText('重试') : moteText('搜索')}
          </button>
        </form>
        {busy && <Loading/>}
        {failed && <p role="alert">{moteText('搜索失败')}</p>}
        {current && current.hits.length === 0 && <p role="status">{moteText('没有匹配的消息')}</p>}
        {current && current.hits.length > 0 && <ul className="chat-search-hits">
          {current.hits.map(({turn, excerpt}) => <li key={turn.id}>
            <button type="button" onClick={() => {close(); onSelect(turn.id, current.page);}}>
              <span>{excerpt}</span><time dateTime={turn.createdAt}>{dateTime(turn.createdAt)}</time>
            </button>
          </li>)}
        </ul>}
      </>}
    </ConversationDialog>
  </>;
}
