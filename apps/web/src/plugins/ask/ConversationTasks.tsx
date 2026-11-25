import {useState, type ReactNode} from 'react';
import {FileText} from 'lucide-react';
import {pageHash, type ConversationTaskStatus} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Answer, Api} from '../../api';
import {FeaturePanels} from '../../features/runtime';
import {useResource} from '../../useResource';
import {AssistantActionResults} from '../work/AssistantActionResults';
import type {AssistantTaskResultItem} from './AssistantTaskResults';
import {ChatProgress} from './ChatProgress';

type Props = {
  api: Api;
  conversationId: string;
  items: ConversationTaskStatus[];
  refresh: () => void;
  onOpen: (ref: string) => void;
  onSupplement: (task: ConversationTaskStatus['task']) => void;
  renderAnswer: (answer: Answer, open: (ref: string) => void) => ReactNode;
};

function TaskResult({api, item, onOpen, renderAnswer}: Pick<Props, 'api' | 'onOpen' | 'renderAnswer'> & {item: ConversationTaskStatus}) {
  const {task} = item;
  const [open, setOpen] = useState(false);
  const path = '/api/assistant/tasks/' + encodeURIComponent(task.id) + '?' + new URLSearchParams({scope: JSON.stringify(task.scope)});
  const read = useResource<AssistantTaskResultItem>(api, open ? path : null, undefined, task.revision, undefined, true);
  const reply = read.error === undefined && read.data?.task.id === task.id && read.data.task.state === 'completed' ? read.data : undefined;
  const [unavailable, setUnavailable] = useState(false);

  async function openCitation(ref: string) {
    try {
      const current = await api.request<AssistantTaskResultItem>(path);
      if (current?.task.id === task.id && current.task.state === 'completed' &&
          current.result?.citations.some(citation => ref === 'capture:' + citation.id)) {
        setUnavailable(false);
        onOpen(ref);
        return;
      }
    } catch { /* Show the same unavailable state if the source was withdrawn. */ }
    setUnavailable(true);
    read.refresh();
  }

  return <details className="chat-task-result" data-message-kind="result" data-task-id={task.id}
    onToggle={event => {setOpen(event.currentTarget.open); if (event.currentTarget.open) setUnavailable(false);}}>
    <summary><FileText size={18} aria-hidden="true"/><span><strong>{task.goal || moteText('结果')}</strong>
      <small>{moteText('已完成')}</small></span><span>{moteText('打开')}</span></summary>
    {open && (reply?.result ? <>
      {renderAnswer(reply.result, ref => void openCitation(ref))}
      {Boolean(reply.actionDrafts?.length) && task.scope && <AssistantActionResults api={api} taskId={task.id} scope={task.scope}/>}
    </> : <p role="status">{read.loading && !read.error ? moteText('正在读取…') : moteText('已失效')}</p>)}
    {open && unavailable && <p role="alert">{moteText('引用不可用')}</p>}
  </details>;
}

function TaskProgress({api, conversationId, item, refresh, onOpen, onSupplement}: Omit<Props, 'items' | 'renderAnswer'> & {item: ConversationTaskStatus}) {
  const {task, turnId, workId, error} = item;
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = task.state;
  const canStop = ['waiting','running','needs_input','failed'].includes(state);
  const canSupplement = Boolean(task.scope) && state !== 'failed' && canStop && error !== 'no_usable_evidence';
  const label = {waiting: '排队中', running: '正在进行', needs_input: '待补充', failed: '未完成',
    cancelled: '已停止', stale: '已失效', excluded: '未完成', completed: '已完成'} as const;

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setFailed(false);
    try {
      const receipt = await api.request<{id: string; state: string}>('/api/conversations/' + encodeURIComponent(conversationId)
        + '/assistant-tasks/' + encodeURIComponent(task.id) + '/cancel', {method: 'POST'});
      if (receipt.id !== task.id || receipt.state !== 'cancelled') throw Error();
    } catch { setFailed(true); }
    finally { setStopping(false); refresh(); }
  }

  return <section className="assistant-task-result" data-task-id={task.id} data-state={state}>
    {state === 'waiting' || state === 'running' ? <ChatProgress state={state}
      label={task.goal ? task.goal + ' · ' + moteText(label[state]) : moteText(label[state])}/>
      : <p>{task.goal ? <strong>{task.goal} · </strong> : null}<span role="status">{moteText(label[state])}</span></p>}
    {error === 'no_usable_evidence' && <p>{moteText('当前范围没有可用正文，任务尚未执行。')}</p>}
    {state === 'needs_input' && workId && error !== 'no_usable_evidence' && <FeaturePanels api={api} onOpen={onOpen}
      value={{kind:'mote.work.activity',schemaVersion:1,representation:'overview',ref:workId,revision:String(task.revision),title:'',text:''}}/>}
    {canSupplement && <button className="text-button" onClick={() => onSupplement(task)}>{moteText('补充')}</button>}
    {canStop && <button className="text-button" disabled={stopping} onClick={() => void stop()}>{moteText('停止')}</button>}
    {!task.goal && <a className="text-button" href={pageHash('chat', {conversation: conversationId, turn: turnId})}>{moteText('查看任务')}</a>}
    {failed && <p role="alert">{moteText('停止失败')}</p>}
  </section>;
}

export function ConversationTasks({items, renderAnswer, ...props}: Props) {
  return <>{items.map(item => item.resultAvailable
    ? <TaskResult key={item.task.id} {...props} item={item} renderAnswer={renderAnswer}/>
    : <TaskProgress key={item.task.id} {...props} item={item}/>)}</>;
}
