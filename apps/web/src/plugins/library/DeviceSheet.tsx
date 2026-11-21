import { moteText } from '@mote/shared/i18n';
import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { containDialogFocus } from '../../dialog-focus';
import { DeviceSettings } from '../../features/devices';
import { DevicePairing } from '../sources/Connections';

type SheetControls = {
    opener: HTMLButtonElement;
    fallbackFocus: HTMLButtonElement | null;
    onClose: () => void;
};

function Sheet({ title, opener, fallbackFocus, onClose, children, wide }: SheetControls & {
    title: string;
    children: ReactNode;
    wide?: boolean;
}) {
    const titleId = useId();
    const panel = useRef<HTMLElement>(null);
    const close = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => {
        const restore = containDialogFocus(panel.current!, opener, close.current);
        return () => {
            restore();
            queueMicrotask(() => {
                if (!opener.isConnected && fallbackFocus?.isConnected) fallbackFocus.focus({ preventScroll: true });
            });
        };
    }, [opener, fallbackFocus]);

    return createPortal(
        <div className="modal-backdrop" onMouseDown={event => {
            if (event.target === event.currentTarget) onClose();
        }} onKeyDown={event => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            onClose();
        }}>
            <section className="modal source-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
                style={wide ? { width: 720 } : undefined}>
                <header>
                    <h2 id={titleId} style={{ overflowWrap: 'anywhere' }}>{title}</h2>
                    <button ref={close} className="icon-button" type="button" aria-label={moteText('关闭')} onClick={onClose}>
                        <X size={18} aria-hidden="true"/>
                    </button>
                </header>
                <div style={{ padding: 'var(--mote-space-panel)' }}>{children}</div>
            </section>
        </div>,
        opener.ownerDocument.body,
    );
}

export function DeviceSheet({ name, opener, fallbackFocus, onClose, ...settings }: SheetControls &
    ComponentProps<typeof DeviceSettings> & { name: string }) {
    return <Sheet title={name} opener={opener} fallbackFocus={fallbackFocus} onClose={onClose}>
        <DeviceSettings {...settings}/>
    </Sheet>;
}

export function DevicePairingSheet({ opener, fallbackFocus, onClose, ...pairing }: SheetControls &
    Omit<ComponentProps<typeof DevicePairing>, 'embedded'>) {
    return <Sheet title={moteText('添加设备')} opener={opener} fallbackFocus={fallbackFocus} onClose={onClose} wide>
        <DevicePairing {...pairing} embedded/>
    </Sheet>;
}
