import {CircleX, LoaderCircle} from 'lucide-react';
import type {WorkActivity} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';

export function ChatProgress({state, label, mode, stop}: {
  state: 'accepted' | 'running' | 'waiting' | 'cancelled';
  label: string;
  mode?: WorkActivity['progress']['mode'];
  stop?: {disabled: boolean; run: () => void};
}) {
  const cancelled = state === 'cancelled';
  return <div className={cancelled ? 'chat-card chat-progress' : 'chat-card chat-progress conversation-pending'} role="status"
    data-message-kind="progress" data-state={state} data-progress={mode}>
    {cancelled ? <CircleX size={18} aria-hidden="true"/> : <LoaderCircle className="spin" size={18} aria-hidden="true"/>}
    <span>{label}</span>
    {stop && <button type="button" className="text-button" disabled={stop.disabled}
      aria-label={moteText('停止这条回答')} onClick={stop.run}>{moteText('停止')}</button>}
  </div>;
}
