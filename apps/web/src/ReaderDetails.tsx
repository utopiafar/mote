import {moteText} from '@mote/shared/i18n';
import {X} from 'lucide-react';
import {useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
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
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [retained, setRetained] = useState(open);
  const lastContents = useRef<ReactNode>(null);
  useLayoutEffect(() => {
    if (open) lastContents.current = children;
    else if (!retained) lastContents.current = null;
  }, [open, retained, children]);
  useLayoutEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const animations = backdrop.current?.getAnimations?.() ?? [];
    if (!animations.length) {
      setRetained(false);
      return;
    }
    let current = true;
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (current) setRetained(false);
    });
    return () => { current = false; };
  }, [open, retained]);
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

  return createPortal(<div ref={backdrop} className="reader-details-backdrop" hidden={!open} inert={!open}
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
      <div className="reader-details-content">{open ? children : retained ? lastContents.current : null}</div>
    </section>
  </div>, opener.current?.ownerDocument.body ?? document.body);
}
