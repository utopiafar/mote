import {useEffect, useId, useRef, type ReactNode} from 'react';
import {X} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {containDialogFocus} from '../../dialog-focus';
import type {Api} from '../../api';

export function revokeAccess(api: Api, id: string, signal: AbortSignal) {
  return api.request(`/api/connections/${encodeURIComponent(id)}`, {method: 'DELETE', signal});
}

export function AccessRevocation({label, calendar, busy, error, cancel, confirm}: {
  label: string; calendar: boolean; busy: boolean; error?: ReactNode; cancel: () => void; confirm: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const title = useId();
  useEffect(() => {
    if (panel.current) return containDialogFocus(panel.current, document.activeElement as HTMLElement | null);
  }, []);
  return <div className="source-dialog-overlay" onKeyDown={event => {if (event.key === 'Escape' && !busy) cancel();}}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={title} className="source-dialog">
      <header><h2 id={title}>{moteText('撤销 {0}', label)}</h2>
        <button className="icon-button" aria-label={moteText('关闭')} disabled={busy} onClick={cancel}><X size={18}/></button>
      </header>
      <p>{calendar ? moteText('撤销后，此连接无法创建新日程。已派发的请求以行动回执为准。')
        : moteText('停止此连接的后续访问，已归档资料保留。再次接入需要生成新配置。')}</p>
      {error}
      <footer><button className="button" disabled={busy} onClick={cancel}>{moteText('取消')}</button>
        <button className="button" disabled={busy} onClick={confirm}>{moteText('确认撤销')}</button>
      </footer>
    </div>
  </div>;
}
