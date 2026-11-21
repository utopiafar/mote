import { moteText } from '@mote/shared/i18n';
import type { Api } from '../../api';
import { confirmNavigation } from '../../unsaved';
import { SettingsSheet } from '../library/DeviceSheet';
import { Imports } from './Imports';

/** The library opens the existing intake flow in a panel instead of a second page. */
export function ImportPanel({ api, refreshVersion, opener, onClose, onOpen, onMemories, onSettings, onChanged }: {
    api: Api;
    refreshVersion: number;
    opener: HTMLElement;
    onClose: () => void;
    onOpen: (ref: string) => void;
    onMemories: () => void;
    onSettings: () => void;
    onChanged: () => void;
}) {
    const close = () => { if (confirmNavigation()) onClose(); };
    return <SettingsSheet title={moteText('导入')} opener={opener} fallbackFocus={opener} onClose={close} wide>
        <div style={{ maxHeight: '72vh', overflow: 'auto' }}>
            <Imports api={api} refreshVersion={refreshVersion} onOpen={onOpen} onMemories={onMemories}
                onSettings={onSettings} onChanged={onChanged} panel/>
        </div>
    </SettingsSheet>;
}
