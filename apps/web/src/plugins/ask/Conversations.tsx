import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {conversationSettingsSchema, pageHash, type ServerConfiguration} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Answer, Api, Device} from '../../api';
import {Loading, LoadingText} from '../../Loading';
import {FeaturePanels} from '../../features/runtime';
import {useOriginalReference} from '../../ask-original-reference';
import {readOwnerQuestion} from '../../owner-question-route';
import {useHashChoice} from '../../useHashChoice';
import {useOperationUpdates} from '../../useOperationUpdates';
import {useResource} from '../../useResource';
import {ConversationSettingsView} from './ConversationSettings';
import {ConversationDialog} from './ConversationTurnDetails';
import {ConversationSourceScope, type SourceScopeChoice} from './ConversationSourceScope';
import {ChatComposer, createChatDraft} from './ChatComposer';
import {ChatRevisionChanged, ChatSearch, chatPath, chatRevoked, mergeChatPages, readChatPage, samePage,
  type ChatPage, type ChatScope, type ChatTurn} from './ChatHistory';
import {ChatMessage} from './ChatMessage';
import {unsentDrafts} from './chat-drafts';
import {useChatAttachments} from './chat-attachments';
import {admitConversationMessage, definiteAdmissionFailure, pendingMessageStatus, readConversationMessage,
  type ConversationMessage, type ConversationMessageInput, type ConversationMessageScope} from './conversation-messages';
import {readOriginTurn} from './conversation-origin';
import {queryRecovery, type OwnedQuery} from './query-recovery';
import type {AskController} from './controller';
const chatStyles = new URL('./chat.css?no-inline', import.meta.url).href;

function admissionScope(scope: ChatScope | undefined, choice: SourceScopeChoice | undefined): ConversationMessageScope {
  const range = {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(scope?.after ? {after: scope.after} : {}),
    ...(scope?.before ? {before: scope.before} : {}),
    ...(scope?.deviceId ? {deviceId: scope.deviceId} : {}),
  };
  if (choice) return {...range, ...choice};
  if (scope?.kind === 'selection' || scope?.evidenceIds !== undefined || scope?.sourceIds !== undefined) {
    return {kind: 'selection', ...range,
      ...(scope.evidenceIds !== undefined ? {evidenceIds: scope.evidenceIds} : {}),
      ...(scope.sourceIds !== undefined ? {sourceIds: scope.sourceIds} : {})};
  }
  return {kind: 'all', ...range};
}

const sessions = new WeakMap<Api, number>();
let nextSession = 0;
type Props = {
  api: Api;
  configured: boolean;
  devices: Device[];
  renderAnswer: (answer: Answer, openReference: (ref: string) => void) => ReactNode;
  onOpen?: (ref: string) => void;
  onSettings?: () => void;
  controller?: AskController;
};
const doNothing = () => {};
const readTurn = (hash: string) => new URLSearchParams(hash.split('?')[1]).get('turn');
const readConversation = (hash: string) => new URLSearchParams(hash.split('?')[1]).get('conversation');

export function Conversations({api, onOpen = doNothing, ...props}: Props) {
  const [ownerQuestion] = useHashChoice('question', readOwnerQuestion);
  if (ownerQuestion !== null) return <FeaturePanels api={api} onOpen={onOpen}
    unavailable={<p role="status">{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>}
    value={{kind: ownerQuestion ? 'mote.ask.question' : 'mote.ask.history', schemaVersion: 1, representation: 'standalone',
      ref: ownerQuestion, revision: '1', title: '', text: ''}}/>;
  if (!sessions.has(api)) sessions.set(api, ++nextSession);
  return <Chat key={sessions.get(api)} {...props} api={api} onOpen={onOpen}/>;
}

function Chat({api, configured, renderAnswer, onOpen, onSettings}: Omit<Props, 'onOpen'> & {onOpen: (ref: string) => void}) {
  useLayoutEffect(() => {
    if (document.head.querySelector('link[data-mote-chat]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chatStyles;
    link.dataset.moteChat = '';
    document.head.append(link);
  }, []);
  const main = useResource<{id: string}>(api, '/api/conversations/main');
  const path = main.data ? chatPath(main.data.id) : null;
  const detail = useResource<ChatPage>(api, path);
  const feedError = useOperationUpdates(api);
  const [revoked, setRevoked] = useState<ChatPage>();
  const head = detail.data?.id === main.data?.id && detail.data !== revoked ? detail.data : undefined;
  const [older, setOlder] = useState<ChatPage>();
  const thread = head && older && samePage(head, older) ? mergeChatPages(older, head) : head;
  const [error, setError] = useState('');
  const [receiptError, setReceiptError] = useState<unknown>();
  const [unavailableReference, setUnavailableReference] = useState(false);
  const [busy, setBusy] = useState(false);
  const [contextSettings, setContextSettings] = useState(false);
  const configuration = useResource<ServerConfiguration>(api, contextSettings ? '/api/configuration' : null);
  const settings = useMemo(() => conversationSettingsSchema.safeParse(
    configuration.data?.domains?.find(domain => domain.id === 'conversations')?.effective,
  ), [configuration.data]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [cancelling, setCancelling] = useState<string>();
  const [model, setModel] = useState('');
  const [override, setOverride] = useState('');
  const [scopeChoice, setScopeChoice] = useState<SourceScopeChoice>();
  const [freshContext, setFreshContext] = useState(false);
  const [highlight, setHighlight] = useState<{id: string}>();
  const [routeTurn, setRouteTurn] = useHashChoice('turn', readTurn);
  const [routeConversation] = useHashChoice('conversation', readConversation);
  const target = highlight?.id ?? (routeConversation === main.data?.id ? routeTurn ?? undefined : undefined);
  const reference = useOriginalReference(api);
  const referenceKey = useRef(reference.key);
  const [draft] = useState(() => createChatDraft(unsentDrafts.get(api)?.question ?? '', question => {
    unsentDrafts.set(api, {question, attachments: unsentDrafts.get(api)?.attachments ?? []});
  }));
  const files = useChatAttachments(api, setError);
  const operation = useRef<AbortController | undefined>(undefined);
  const olderRequest = useRef<AbortController | undefined>(undefined);
  const cancelRequest = useRef<AbortController | undefined>(undefined);
  const citeRequest = useRef<AbortController | undefined>(undefined);
  const viewport = useRef<HTMLDivElement>(null);
  const scrollToBottom = useRef(true);
  const growth = useRef<{height: number; top: number} | undefined>(undefined);
  const latest = useRef({head, thread});
  latest.current = {head, thread};

  const storedScope = freshContext ? undefined : head?.scope;
  const sourceScope = reference.scope ?? storedScope;
  const outgoingScope = admissionScope(sourceScope, scopeChoice);
  const recovery = useSyncExternalStore(
    useCallback(listener => queryRecovery.subscribe(api, listener), [api]),
    useCallback(() => queryRecovery.get(api), [api]),
    useCallback(() => queryRecovery.get(api), [api]),
  );
  const retryable = recovery?.kind === 'owned' && recovery.conversationId === main.data?.id && recovery.unknown;
  const preparing = !head;
  const pending = thread?.turns.filter(turn => pendingMessageStatus(turn.status)) ?? [];
  const pendingKey = JSON.stringify(pending.map(({id, status, version}) => [id, status, version]));
  const readError = main.error ?? detail.error ?? receiptError ?? feedError;
  const offline = readError instanceof TypeError;

  useEffect(() => () => {
    operation.current?.abort();
    const retained = queryRecovery.get(api);
    if (retained) queryRecovery.set(api, {...retained, unknown: true});
  }, [api]);
  useEffect(() => {
    setCancelling(undefined);
    setReceiptError(undefined);
    setUnavailableReference(false);
    return () => {
      olderRequest.current?.abort();
      cancelRequest.current?.abort();
      citeRequest.current?.abort();
      olderRequest.current = undefined;
      cancelRequest.current = undefined;
      citeRequest.current = undefined;
    };
  }, [head?.id]);
  useEffect(() => {
    olderRequest.current?.abort();
    olderRequest.current = undefined;
    setLoadingOlder(false);
    setOlder(undefined);
  }, [head?.id, head?.revision]);
  useEffect(() => {
    if (reference.key !== referenceKey.current) {
      referenceKey.current = reference.key;
      queryRecovery.contextChanged(api);
      if (reference.key) setScopeChoice(undefined);
    }
  }, [api, reference.key]);
  useEffect(() => {
    function takeDraft() {
      const hash = window.location.hash;
      const [route, query] = hash.split('?');
      const params = new URLSearchParams(query);
      const incoming = params.get('questionDraft');
      if (incoming === null) return;
      files.clear();
      queryRecovery.contextChanged(api);
      if (!params.has('conversation')) {
        setFreshContext(true);
        setScopeChoice(undefined);
      }
      draft.set(incoming.slice(0, 8000));
      params.delete('questionDraft');
      window.history.replaceState(null, '', route + (params.size ? '?' + params : ''));
      window.dispatchEvent(new window.Event('mote:workspace-state'));
    }
    takeDraft();
    window.addEventListener('hashchange', takeDraft);
    return () => window.removeEventListener('hashchange', takeDraft);
  }, [api, draft]);

  useEffect(() => {
    if (!head?.id || pendingKey === '[]') return;
    const id = head.id;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      if (!document.hidden) timer = setTimeout(() => void poll(), 1200);
    }
    async function poll() {
      const controller = new AbortController();
      request = controller;
      try {
        let changed = false;
        for (const turn of latest.current.thread?.turns ?? []) {
          if (!pendingMessageStatus(turn.status)) continue;
          const actual = await readConversationMessage(api, id, turn.id, controller.signal);
          controller.signal.throwIfAborted();
          if (actual.id !== turn.id) throw new Error('Conversation receipt identity changed');
          changed ||= actual.status !== turn.status || turn.version !== undefined && actual.revision !== turn.version;
        }
        setReceiptError(undefined);
        if (changed) detail.refresh();
      } catch (reason) {
        if (!controller.signal.aborted) setReceiptError(reason);
      } finally {
        if (request === controller) request = undefined;
        if (!controller.signal.aborted) schedule();
      }
    }
    function stop() {
      clearTimeout(timer);
      request?.abort();
    }
    function visibility() {
      stop();
      if (!document.hidden) void poll();
    }
    schedule();
    document.addEventListener('visibilitychange', visibility);
    return () => {stop(); document.removeEventListener('visibilitychange', visibility);};
  }, [api, head?.id, pendingKey, detail.refresh]);

  useLayoutEffect(() => {
    const container = viewport.current;
    if (!container) return;
    if (growth.current) {
      const {height, top} = growth.current;
      growth.current = undefined;
      container.scrollTop = top + container.scrollHeight - height;
    } else if (!target && scrollToBottom.current) container.scrollTop = container.scrollHeight;
  }, [thread?.turns.length, target]);

  useEffect(() => {
    const container = viewport.current;
    if (!container?.firstElementChild || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (!target && scrollToBottom.current) container.scrollTop = container.scrollHeight;
    });
    observer.observe(container.firstElementChild);
    return () => observer.disconnect();
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const element = document.getElementById('conversation-turn-' + target);
    if (!element) return;
    element.scrollIntoView?.({block: 'center'});
    element.focus({preventScroll: true});
  }, [target, highlight, thread?.turns.length]);

  useEffect(() => {
    if (!target || !head || thread?.turns.some(turn => turn.id === target) || !detail.data) return;
    const controller = new AbortController();
    void readChatPage(api, head, new URLSearchParams({anchor: target}), controller.signal).then(page => {
      if (samePage(latest.current.head, head)) setOlder(page);
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof ChatRevisionChanged) invalidate(head);
      else setError(moteText('原始轮次暂不可读。'));
    });
    return () => controller.abort();
  }, [api, head, target]);

  function invalidate(page: ChatPage) {
    setRevoked(page);
    setOlder(undefined);
    detail.refresh();
  }

  async function loadOlder() {
    if (!head || !thread?.nextCursor || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingOlder(true);
    setError('');
    try {
      const page = await readChatPage(api, head, new URLSearchParams({cursor: thread.nextCursor}), controller.signal);
      if (!samePage(latest.current.head, head)) return;
      scrollToBottom.current = false;
      if (viewport.current) growth.current = {height: viewport.current.scrollHeight, top: viewport.current.scrollTop};
      setOlder(mergeChatPages(page, thread));
    } catch (reason) {
      if (controller.signal.aborted || !samePage(latest.current.head, head)) return;
      if (reason instanceof ChatRevisionChanged || chatRevoked(reason)) invalidate(head);
      setError(moteText('读取失败'));
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = undefined;
        setLoadingOlder(false);
      }
    }
  }

  async function openReference(ref: string, turn?: ChatTurn) {
    if (!head || !ref.startsWith('capture:')) {onOpen(ref); return;}
    const evidenceId = ref.slice('capture:'.length);
    const matches = (value: Pick<ChatTurn, 'question' | 'evidenceDeleted' | 'evidenceStale' | 'result'> | undefined) =>
      Boolean(value && turn && !value.evidenceDeleted && !value.evidenceStale && value.question === turn.question &&
        value.result?.answer === turn.result?.answer && value.result?.citations.some(citation => citation.id === evidenceId));
    if (turn && !matches(turn)) {setUnavailableReference(true); return;}
    citeRequest.current?.abort();
    const controller = new AbortController();
    citeRequest.current = controller;
    const current = () => !controller.signal.aborted && latest.current.head?.id === head.id &&
      (!turn || matches(latest.current.thread?.turns.find(candidate => candidate.id === turn.id)));
    try {
      const availability = await api.request<{id: string; available: boolean}>(
        chatPath(head.id) + '/references/' + encodeURIComponent(evidenceId), {signal: controller.signal});
      if (!current()) return;
      if (availability.id !== evidenceId || availability.available !== true) {setUnavailableReference(true); return;}
      if (turn) {
        const checked = await readOriginTurn(api, head.id, turn.id, controller.signal);
        if (!current()) return;
        if (!matches(checked)) {setUnavailableReference(true); return;}
      }
      onOpen(ref);
    } catch {
      if (current()) setUnavailableReference(true);
    } finally {
      if (citeRequest.current === controller) citeRequest.current = undefined;
    }
  }

  async function post(retained: OwnedQuery, signal: AbortSignal) {
    let unknown = retained.unknown;
    const input = JSON.parse(retained.body) as ConversationMessageInput;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await admitConversationMessage(api, input, signal);
        signal.throwIfAborted();
        const versions = queryRecovery.versions(api);
        if (versions.draftVersion === retained.draftVersion && draft.read().trim() === retained.question) {
          draft.set('');
          files.clear();
        }
        if (versions.contextVersion === retained.contextVersion && reference.key) reference.clear();
        queryRecovery.set(api, undefined);
        setReceiptError(undefined);
        detail.refresh();
        return;
      } catch (reason) {
        if (signal.aborted) return;
        if (!unknown && definiteAdmissionFailure(reason)) {
          queryRecovery.set(api, undefined);
          setError(moteText('发送失败'));
          return;
        }
        unknown = true;
        queryRecovery.set(api, {...retained, unknown});
        if (attempt === 1) setReceiptError(reason);
      }
    }
  }

  async function submit(original?: ChatTurn) {
    const question = (original?.question ?? draft.read()).trim();
    if (!head || !question || !configured || !reference.ready || files.uploading || files.pending.length ||
      operation.current || queryRecovery.get(api)) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    setHighlight(undefined);
    if (routeTurn) setRouteTurn(null);
    scrollToBottom.current = true;
    try {
      const scope = original?.scope ? admissionScope(original.scope, undefined) : outgoingScope;
      if (!original && !scopeChoice) await reference.verify(controller.signal);
      controller.signal.throwIfAborted();
      const anchor = original ? original.scope : scopeChoice ? undefined : reference.origin
        ? {anchorMaterialRef: reference.materialRef, anchorEvidenceIds: reference.ids.length ? reference.ids : undefined}
        : storedScope;
      const attachments = original ? original.attachments ?? [] : unsentDrafts.get(api)?.attachments ?? [];
      const clientRequestId = crypto.randomUUID();
      const modelProfileId = original ? original.modelProfileId : model;
      const modelOverride = original ? original.modelOverride : override;
      const input: ConversationMessageInput = {
        conversationId: head.id, clientRequestId, question, scope,
        ...(anchor?.anchorMaterialRef ? {anchorMaterialRef: anchor.anchorMaterialRef} :
          anchor?.anchorEvidenceIds?.length ? {anchorEvidenceIds: anchor.anchorEvidenceIds} : {}),
        ...(attachments.length ? {attachmentIds: attachments.map(item => item.id)} : {}),
        ...(modelProfileId ? {modelProfileId} : {}),
        ...(modelOverride ? {modelOverride} : {}),
      };
      const retained: OwnedQuery = {kind: 'owned', id: clientRequestId, body: JSON.stringify(input),
        question, attachments, ...queryRecovery.versions(api), conversationId: head.id, unknown: false};
      queryRecovery.set(api, retained);
      await post(retained, controller.signal);
    } catch {
      if (!controller.signal.aborted) setError(moteText('发送失败'));
    } finally {
      if (operation.current === controller) operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function retrySend() {
    if (!retryable || operation.current || files.uploading) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    try {
      await post(recovery, controller.signal);
    } finally {
      if (operation.current === controller) operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function cancel(turn: ChatTurn) {
    if (!head || cancelRequest.current) return;
    const controller = new AbortController();
    cancelRequest.current = controller;
    setCancelling(turn.id);
    setError('');
    try {
      const result = await api.request<ConversationMessage>(chatPath(head.id) + '/messages/' + encodeURIComponent(turn.id) + '/cancel',
        {method: 'POST', signal: controller.signal});
      if (controller.signal.aborted || latest.current.head?.id !== head.id) return;
      if (result.id !== turn.id || result.conversationId !== head.id) throw new Error('Conversation receipt identity changed');
      detail.refresh();
    } catch {
      if (!controller.signal.aborted) setError(moteText('停止失败'));
    } finally {
      if (cancelRequest.current === controller) {
        cancelRequest.current = undefined;
        setCancelling(undefined);
      }
    }
  }

  function changeScope(value: SourceScopeChoice) {
    queryRecovery.contextChanged(api);
    setScopeChoice(value);
    reference.clear();
  }
  const changeModel = useCallback((value: string) => {queryRecovery.draftEdited(api); setModel(value);}, [api]);
  const changeOverride = useCallback((value: string) => {queryRecovery.draftEdited(api); setOverride(value);}, [api]);

  const inherited = scopeChoice || reference.origin ? undefined : storedScope;
  const pinnedIds = inherited?.evidenceIds?.length ? inherited.evidenceIds : inherited?.anchorEvidenceIds;
  const pinnedMaterial = pinnedIds?.length ? undefined : inherited?.anchorMaterialRef;
  const hasEvidenceScope = Boolean(inherited?.evidenceIds?.length);
  const clearScope = () => changeScope({kind: 'all'});
  const referenceOrigin = reference.origin;

  return <section className="conversation-layout chat-page" aria-label={moteText('聊天')} aria-busy={preparing && !readError}>
    <header className="chat-header">
      <h1>{moteText('聊天')}</h1>
      <ChatSearch api={api} head={head} onInvalidated={() => {if (head) invalidate(head);}} onSelect={(id, page) => {
        if (!samePage(latest.current.head, page)) return;
        olderRequest.current?.abort();
        olderRequest.current = undefined;
        setLoadingOlder(false);
        setOlder(page);
        setHighlight({id});
      }}/>
    </header>
    <div className="chat-viewport" ref={viewport} onScroll={event => {
      const element = event.currentTarget;
      scrollToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    }}>
      <div className="conversation-messages chat-thread">
        {preparing && !readError && <Loading label={moteText('正在打开对话…')}/>}
        {thread?.nextCursor && <button className="text-button chat-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? <LoadingText/> : moteText('加载更早的消息')}
        </button>}
        {thread?.turns.map((turn, index, turns) => <ChatMessage key={turn.id} api={api} conversationId={thread.id} turn={turn}
          previous={turns[index - 1]} pending={pending} turns={turns} highlighted={target === turn.id} cancelling={cancelling !== undefined}
          canRetry={!busy && Boolean(head) && configured && !recovery}
          onCancel={() => void cancel(turn)} onRetry={() => void submit(turn)} onOpen={onOpen}
          openReference={ref => void openReference(ref, turn)} renderAnswer={renderAnswer}/>)}
      </div>
    </div>
    {unavailableReference && <ConversationDialog open title={moteText('引用不可用')} onClose={() => setUnavailableReference(false)}
      footer={<button className="button subtle" onClick={() => setUnavailableReference(false)}>{moteText('返回原对话')}</button>}>
      {null}
    </ConversationDialog>}
    {contextSettings && <ConversationDialog open title={moteText('上下文设置')} onClose={() => setContextSettings(false)}>
      {configuration.loading && !configuration.data ? <Loading/> :
        configuration.error ? <div className="chat-error" role="alert">
          {moteText('读取失败')}<button className="text-button" onClick={configuration.refresh}>{moteText('重试')}</button>
        </div> : <ConversationSettingsView api={api} settings={settings.data}
          revision={configuration.data?.revision} onSaved={configuration.refresh}/>}
    </ConversationDialog>}
    <div className="chat-composer-area">
      {Boolean(readError || error || retryable) && <div className="chat-error" role="alert">
        <span>{offline ? moteText('没连上') : error || (retryable ? moteText('发送结果待确认') : moteText('读取失败'))}</span>
        {retryable ? <button type="button" className="text-button" disabled={busy || preparing} onClick={() => void retrySend()}>{moteText('重试')}</button>
          : readError ? <button type="button" className="text-button" onClick={() => {
            setError('');
            setReceiptError(undefined);
            if (!main.data || chatRevoked(detail.error)) main.refresh();
            detail.refresh();
          }}>{moteText('重试')}</button> : null}
      </div>}
      {!configured && onSettings && <div className="chat-error" role="status">
        <span>{moteText('未连接模型')}</span><button className="text-button" onClick={onSettings}>{moteText('打开模型设置')}</button>
      </div>}
      <ChatComposer api={api} draft={draft} files={files} busy={busy} preparing={preparing}
        blocked={preparing || !configured || !reference.ready || Boolean(recovery)} model={model} override={override}
        onModel={changeModel} onOverride={changeOverride}
        onEdit={value => {queryRecovery.draftEdited(api); draft.set(value);}}
        onSend={() => void submit()}
        options={<>
          <ConversationSourceScope api={api} scope={outgoingScope} onChange={changeScope} disabled={preparing || busy}/>
          <button type="button" className="text-button" onClick={() => setContextSettings(true)}>{moteText('上下文设置')}</button>
        </>}
        reference={referenceOrigin ? <nav className="filter-bar ask-original-reference" aria-label={moteText('参考记录')}>
          <span>{reference.title || moteText('参考资料')}</span>
          {reference.loading && <LoadingText/>}
          {reference.error && <span role="alert">{moteText('引用不可用')}</span>}
          {reference.ready && reference.materialRef && <button type="button" className="text-button"
            onClick={() => onOpen(reference.materialRef!)}>{moteText('查看参考资料')}</button>}
          {reference.ids.map((id, index) => <button type="button" className="text-button" key={id}
            onClick={() => onOpen('capture:' + id)}>{moteText('查看原文依据')} {index + 1}</button>)}
          <a className="text-button" href={reference.returnRoute ?? (referenceOrigin.kind === 'memory'
            ? pageHash('library', {view: 'memories', memory: referenceOrigin.id})
            : pageHash('library', {view: 'materials', selected: referenceOrigin.kind === 'material'
              ? referenceOrigin.id : 'capture:' + referenceOrigin.id}))}>
            {referenceOrigin.kind === 'memory' ? moteText('返回记忆') : moteText('返回资料')}
          </a>
          <button type="button" className="text-button" disabled={busy} onClick={() => {
            queryRecovery.contextChanged(api);
            reference.clear();
          }}>{moteText('清除参考记录')}</button>
        </nav> : pinnedMaterial ? <nav className="filter-bar" aria-label={moteText('参考资料')}>
          <button type="button" className="text-button" onClick={() => onOpen(pinnedMaterial)}>{moteText('查看参考资料')}</button>
          <button type="button" className="text-button" disabled={busy} onClick={clearScope}>{moteText('清除参考记录')}</button>
        </nav> : pinnedIds?.length ? <nav className="filter-bar" aria-label={hasEvidenceScope ? moteText('查询范围') : moteText('参考记录')}>
          {hasEvidenceScope && <span>{moteText('{0} 条证据', pinnedIds.length)}</span>}
          {pinnedIds.map((id, index) => <button type="button" className="text-button" key={id}
            onClick={() => void openReference('capture:' + id)}>{moteText('查看原文依据')} {index + 1}</button>)}
          <button type="button" className="text-button" disabled={busy} onClick={clearScope}>
            {hasEvidenceScope ? moteText('清除范围') : moteText('清除参考记录')}
          </button>
        </nav> : null}/>
    </div>
  </section>;
}
