import {moteText} from '@mote/shared/i18n';
import {X} from 'lucide-react';
import {useId, useLayoutEffect, useRef, type ReactNode, type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {containDialogFocus} from './dialog-focus';

/** Keep the reader mounted while its secondary information is inspected. */
export function ReaderDetails({open, opener, onClose, children}: {
  open: boolean;
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const trigger = opener.current;
    const restore = containDialogFocus(panel.current, null, close.current);
    return () => {
      restore();
      queueMicrotask(() => {
        if (panel.current && !panel.current.closest('[hidden]')) return;
        if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({preventScroll:true});
      });
    };
  }, [open, opener]);

  return createPortal(<div className="reader-details-backdrop" hidden={!open} inert={!open}
    onMouseDown={event => { if (open && event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    <section ref={panel} className="reader-details-panel" role={open ? 'dialog' : undefined}
      aria-modal={open || undefined} aria-labelledby={id}>
      <header>
        <h2 id={id}>{moteText('来源与处理')}</h2>
        <button ref={close} className="icon-button" type="button" onClick={onClose} aria-label={moteText('关闭详情')}>
          <X size={18} aria-hidden="true"/>
        </button>
      </header>
      <div className="reader-details-content">{children}</div>
    </section>
  </div>, opener.current?.ownerDocument.body ?? document.body);
}
