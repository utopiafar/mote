import { moteText } from '@mote/shared/i18n';
import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { containDialogFocus } from '../../dialog-focus';
import { DeviceSettings } from '../../features/devices';
import { RecordingsSettings } from '../../RecordingsSettings';
import { confirmNavigation } from '../../unsaved';
import { DevicePairing } from '../sources/Connections';

type SheetControls = {
    opener: HTMLElement | null;
    fallbackFocus: HTMLElement | null;
    onClose: () => void;
};

/** Shared modal ownership for source settings and intake without duplicating focus containment. */
export function SettingsSheet({ title, opener, fallbackFocus, onClose, children, wide }: SheetControls & {
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
                if (!opener?.isConnected && fallbackFocus?.isConnected) fallbackFocus.focus({ preventScroll: true });
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
        opener?.ownerDocument.body ?? document.body,
    );
}

export function DeviceSheet({ name, opener, fallbackFocus, onClose, onOpen, ...settings }: SheetControls &
    ComponentProps<typeof DeviceSettings> & { name: string; onOpen?: (ref: string) => void }) {
    const close = () => { if (confirmNavigation()) onClose(); };
    const [recording,setRecording]=useState('');
    return <SettingsSheet title={name} opener={opener} fallbackFocus={fallbackFocus} onClose={close}>
        <DeviceSettings {...settings}/>
        {onOpen && <details className="connector-details device-recording-sources">
            <summary>{moteText('录音来源')}</summary>
            <RecordingsSettings api={settings.api} embedded selected={recording} onSelect={setRecording} onOpen={onOpen} onSources={() => {}}/>
        </details>}
    </SettingsSheet>;
}

export function DevicePairingSheet({ opener, fallbackFocus, onClose, ...pairing }: SheetControls &
    Omit<ComponentProps<typeof DevicePairing>, 'embedded'>) {
    return <SettingsSheet title={moteText('添加设备')} opener={opener} fallbackFocus={fallbackFocus} onClose={onClose} wide>
        <DevicePairing {...pairing} embedded/>
    </SettingsSheet>;
}

/** Recording connections use the same sheet from a source chip and from the library query. */
export function RecordingSourcesSheet({ api, initialProvider, opener, fallbackFocus, onClose, onOpen }: SheetControls & {
    api: ComponentProps<typeof DeviceSettings>['api'];
    initialProvider?: string;
    onOpen: (ref: string) => void;
}) {
    const [selected, setSelected] = useState(initialProvider ?? '');
    const close = () => { if (confirmNavigation()) onClose(); };
    return <SettingsSheet title={moteText('录音来源')} opener={opener} fallbackFocus={fallbackFocus} onClose={close} wide>
        <RecordingsSettings api={api} embedded selected={selected} onSelect={setSelected} onOpen={onOpen} onSources={() => {}}/>
    </SettingsSheet>;
}
