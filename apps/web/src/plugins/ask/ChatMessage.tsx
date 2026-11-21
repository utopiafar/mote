import {useCallback, useRef, useState, type ReactNode} from 'react';
import {CalendarDays, Copy, MoreHorizontal} from 'lucide-react';
import {isCentralConnectorActionTarget, pageHash, type ActionConnectorChoice, type ActionProposal,
  type CurrentActionReference, type WorkActivity} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {dateTime, type Answer, type Api} from '../../api';
import {actionEventTime, calendarStateLabel} from '../../action-presentation';
import {useResource} from '../../useResource';
import {AssistantDraftActions} from './AssistantDraftActions';
import type {AssistantTaskResultItem} from './AssistantTaskResults';
import {ChatAttachmentView} from './chat-attachments';
import {hiddenAnswer, type ChatTurn} from './ChatHistory';
import {ChatProgress} from './ChatProgress';
import {conversationFailure, ConversationTurnDetails} from './ConversationTurnDetails';
import {SaveConversationRecord} from './SaveConversationRecord';
import {messageStateLabel, pendingMessageStatus} from './conversation-messages';

function CalendarReceipt({api, reference, conversationId, turnId}: {
  api: Api; reference: CurrentActionReference; conversationId: string; turnId: string;
}) {
  const read = useResource<ActionProposal>(api, '/api/actions/' + encodeURIComponent(reference.id), 15000);
  const [busy, setBusy] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const item = read.data;
  const action = !read.error && item?.id === reference.id && item.kind === reference.kind &&
    item.ownerInstruction?.conversationId === conversationId && item.ownerInstruction.messageId === turnId ? item : undefined;
  const target = action?.target ?? action?.related?.target;
  const connectorTarget = isCentralConnectorActionTarget(target) ? target : undefined;
  const actionList = useResource<{connectorTargets?: ActionConnectorChoice[]}>(api,
    connectorTarget && action?.status !== 'stale' ? '/api/actions' : null);
  if (read.loading && !item) return <p role="status" className="chat-message-status">{moteText('正在读取…')}</p>;
  if (!action) return <div className="chat-card" data-message-kind="calendar" data-state="read-failed" role="alert">
    <CalendarDays size={18}/><span>{moteText('日程读取失败')}</span>
    <button className="text-button" onClick={read.refresh}>{moteText('重试')}</button>
  </div>;
  if (action.status === 'stale') return <p className="chat-message-status" role="status">{moteText('已失效')}</p>;

  async function cancel() {
    if (!action || busy) return;
    setBusy(true);
    setCancelFailed(false);
    try {
      await api.request('/api/managed-calendar/' + encodeURIComponent(action.id) + '/cancel', {
        method: 'POST', body: JSON.stringify({version: action.version}),
      });
      read.refresh();
    } catch {
      setCancelFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const connector = connectorTarget && actionList.error === undefined
    ? actionList.data?.connectorTargets?.find(({target: candidate}) =>
      candidate.executionLocation === connectorTarget.executionLocation && candidate.packageId === connectorTarget.packageId &&
      candidate.instanceId === connectorTarget.instanceId && candidate.instanceRevision === connectorTarget.instanceRevision &&
      candidate.capabilityId === connectorTarget.capabilityId && candidate.capabilityVersion === connectorTarget.capabilityVersion &&
      candidate.calendarId === connectorTarget.calendarId)
    : undefined;
  const destination = connectorTarget ? connector?.name ?? moteText('中央连接器') : target?.calendarId;
  const state = action.kind === 'calendar.create' && action.status === 'succeeded' && !action.resolution
    ? moteText('已创建') : calendarStateLabel(action);
  const canStop = !action.cancelRequestedAt && (action.status === 'approved' || action.status === 'executing');
  return <section className="chat-card" data-message-kind="calendar" data-state={action.status} data-action-id={action.id}
    aria-label={moteText('日程')}>
    <CalendarDays size={19} aria-hidden="true"/>
    <div><strong>{action.event.title}</strong>
      <p className="chat-card-detail">{actionEventTime(action.event)}</p>
      <p className="chat-card-detail">{destination && <>{destination} · </>}
        <span role={action.status === 'uncertain' ? 'alert' : 'status'}>{state}</span></p>
      {cancelFailed && <p role="alert">{moteText('停止失败')}</p>}
    </div>
    {canStop ? <button className="text-button" disabled={busy} onClick={() => void cancel()}>{moteText('停止')}</button>
      : <a className="text-button" href={pageHash('actions', {action: action.id})}>{moteText('查看')}</a>}
  </section>;
}

function ProgressRow({api, runId, state, cancelling, onCancel}: {
  api: Api; runId?: string; state: 'accepted' | 'running'; cancelling: boolean; onCancel: () => void;
}) {
  const workId = runId ? 'query:' + runId : undefined;
  const work = useResource<WorkActivity>(api, workId ? '/api/work-activity/' + encodeURIComponent(workId) : null);
  const progress = !work.error && work.data?.id === workId ? work.data?.progress : undefined;
  const label = progress?.mode === 'determinate' ? moteText('读取资料 {0}/{1}', progress.completed, progress.total)
    : progress?.mode === 'semantic' && progress.stage === 'searching' ? moteText('读取资料') : messageStateLabel(state);
  return <ChatProgress state={state} label={label} mode={progress?.mode} stop={{disabled: cancelling, run: onCancel}}/>;
}

function TaskAmendment({api, turn, cancelling, onCancel}: {api: Api; turn: ChatTurn; cancelling: boolean; onCancel: () => void}) {
  const receipt = turn.taskSteering!;
  const path = '/api/assistant/tasks/' + encodeURIComponent(receipt.targetTaskId) + '?' +
    new URLSearchParams({scope: JSON.stringify(receipt.scope)});
  const read = useResource<AssistantTaskResultItem>(api, path, 2000, turn.version);
  const state = !read.error && read.data?.task.id === receipt.targetTaskId ? read.data.task.state : undefined;
  const labels = {completed: moteText('已完成'), running: moteText('正在进行'), waiting: moteText('排队中'),
    stale: moteText('已失效'), cancelled: moteText('已取消'), failed: moteText('未完成'),
    needs_input: moteText('待补充'), excluded: moteText('未完成')};
  const canCancel = state && ['waiting', 'running', 'needs_input', 'failed'].includes(state) && receipt.state !== 'cancelled';
  return <section className="chat-message-status conversation-task-amendment" aria-label={moteText('任务状态')}>
    <span role={read.error ? 'alert' : 'status'}>{state ? labels[state] : read.error ? moteText('读取失败') : moteText('正在读取…')}</span>
    {read.error !== undefined && <button className="text-button" onClick={read.refresh}>{moteText('重试')}</button>}
    {state && receipt.origin && <a className="text-button" href={pageHash('chat', {
      conversation: receipt.origin.conversationId, turn: receipt.origin.turnId,
    })}>{moteText('查看任务')}</a>}
    {canCancel && <button className="text-button" disabled={cancelling || read.loading}
      onClick={onCancel}>{moteText('停止这条回答')}</button>}
  </section>;
}

function AnswerActions({api, conversationId, turn, answer, onOpen, openReference}: {
  api: Api; conversationId: string; turn: ChatTurn; answer: Answer;
  onOpen: (ref: string) => void; openReference: (ref: string) => void;
}) {
  const [details, setDetails] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(answer.answer);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return <div className="conversation-turn-actions chat-answer-actions">
    <button type="button" className="icon-button" aria-label={moteText('复制')} title={moteText('复制')}
      onClick={() => void copy()}><Copy size={15}/></button>
    <details className="chat-answer-more" onKeyDown={event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.stopPropagation();
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }}>
      <summary className="icon-button" aria-label={moteText('更多')} title={moteText('更多')}><MoreHorizontal size={17}/></summary>
      <div className="chat-answer-menu">
        <SaveConversationRecord inDialog api={api} conversationId={conversationId} messageId={turn.id}
          question={turn.question} answer={answer.answer} answerDetails={answer} formatError={conversationFailure} onOpen={onOpen}/>
        <button type="button" className="text-button" onClick={() => setDetails(true)}>{moteText('本轮详情')}</button>
      </div>
    </details>
    {copyState !== 'idle' && <span role="status">{copyState === 'copied' ? moteText('已复制') : moteText('复制失败')}</span>}
    <ConversationTurnDetails api={api} conversationId={conversationId} id={turn.id} question={turn.question}
      answer={answer} open={details} onClose={() => setDetails(false)} onOpen={ref => {setDetails(false); openReference(ref);}}
      pollError=""/>
  </div>;
}

function startsGroup(turn: ChatTurn, previous?: ChatTurn) {
  // Group nearby messages without repeating the same timestamp on every bubble.
  return !previous || new Date(turn.createdAt).toDateString() !== new Date(previous.createdAt).toDateString() ||
    Date.parse(turn.createdAt) - Date.parse(previous.createdAt) >= 30 * 60 * 1000;
}

export function ChatMessage({api, turn, previous, conversationId, pending, turns, highlighted, cancelling, canRetry,
  onCancel, onRetry, onOpen, openReference, renderAnswer}: {
  api: Api; turn: ChatTurn; previous?: ChatTurn; conversationId: string; pending: ChatTurn[];
  turns: ChatTurn[]; highlighted: boolean; cancelling: boolean; canRetry: boolean; onCancel: () => void; onRetry: () => void;
  onOpen: (ref: string) => void; openReference: (ref: string) => void;
  renderAnswer: (answer: Answer, open: (ref: string) => void) => ReactNode;
}) {
  const open = useRef(openReference);
  open.current = openReference;
  const openCitation = useCallback((ref: string) => open.current(ref), []);
  const result = hiddenAnswer(turn) ? undefined : turn.result;
  const {status} = turn;
  const inFlight = pendingMessageStatus(status);
  const amended = Boolean(turn.steering || turn.taskSteering);
  const showProgress = !amended && (status === 'accepted' || status === 'running');
  const canStopSupplement = turn.steering?.state === 'accepted' && pending.some(item => item.id === turn.steering?.targetMessageId);
  const linkedIds = new Set([...(turn.amendedBy ?? []), ...(turn.supersededBy ?? []),
    ...(turn.steering ? [turn.steering.targetMessageId] : [])]);
  const related = linkedIds.size ? turns.filter(item => linkedIds.has(item.id)) : [];

  const action = result?.currentAction && !turn.supersededBy?.length ? result.currentAction : undefined;
  const draft = result?.draft && !turn.supersededBy?.length ? result.draft : undefined;

  return <article className="conversation-turn chat-message" id={'conversation-turn-' + turn.id} tabIndex={-1}
    data-source-turn={highlighted ? 'true' : undefined} data-state={status}>
    {startsGroup(turn, previous) && <time className="chat-time" dateTime={turn.createdAt}>{dateTime(turn.createdAt)}</time>}
    <div className="asked-question">{turn.question}
      {Boolean(turn.attachments?.length) && <div className="chat-attached-images">
        {turn.attachments!.map(attachment => <ChatAttachmentView api={api} key={attachment.id} attachment={attachment} onOpen={onOpen}/>)}
      </div>}
    </div>
    {hiddenAnswer(turn) ? <p className="chat-message-status" role="status" data-message-kind="stale">{moteText('已失效')}</p>
      : showProgress ? <ProgressRow api={api} runId={turn.runId} state={status} cancelling={cancelling} onCancel={onCancel}/>
      : inFlight ? <div className="chat-message-status" role="status">
        <span>{messageStateLabel(status)}</span>
        <button className="text-button" aria-label={moteText('停止这条回答')} disabled={cancelling} onClick={onCancel}>{moteText('停止')}</button>
      </div>
      : status === 'cancelled' ? amended
        ? <p className="chat-message-status" role="status">{moteText('已取消')}</p>
        : <ChatProgress state="cancelled" label={moteText('已取消')}/>
      : status === 'failed' ? <div className="chat-message-status" role="alert">
        <span>{moteText('这次回答没有完成')}</span>
        <button className="text-button" disabled={!canRetry} onClick={onRetry}>{moteText('重试')}</button>
      </div>
      : result && <div className="chat-response">
        {action ? <CalendarReceipt key={action.id} api={api} reference={action} conversationId={conversationId} turnId={turn.id}/>
          : <div className="chat-answer">{renderAnswer(result, openCitation)}</div>}
        {draft && <AssistantDraftActions key={draft.requestId} api={api} conversationId={conversationId} turnId={turn.id}
          draft={draft} renderAnswer={renderAnswer} onOpen={onOpen}/>}
        {canStopSupplement && <button className="text-button" disabled={cancelling} onClick={onCancel}>{moteText('停止这条回答')}</button>}
        <AnswerActions key={result.runId} api={api} conversationId={conversationId} turn={turn} answer={result} onOpen={onOpen}
          openReference={openCitation}/>
      </div>}
    {related.length > 0 && <div className="conversation-steering-links">
      {related.map(item => <a key={item.id} className="text-button" href={pageHash('chat', {conversation: conversationId, turn: item.id})}>
        {item.question}
      </a>)}
    </div>}
    {turn.taskSteering && <TaskAmendment api={api} turn={turn} cancelling={cancelling} onCancel={onCancel}/>}
  </article>;
}
