import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { configureLocale } from '@mote/shared/i18n';
import { createApi } from '../../../web/src/api';
import { SourceBar, type SourceBarFilter } from '../../../web/src/plugins/library/SourceBar';
import { useResource } from '../../../web/src/useResource';
import type { OwnerBrowseEntry } from '../../src/owner-library-browse.js';
import '../../../web/src/styles.css';

configureLocale(() => 'zh-CN');
const token = document.querySelector<HTMLMetaElement>('meta[name="lb1-test-token"]')?.content;
if (location.hostname !== '127.0.0.1' || !token?.startsWith('generated-lb1-')) throw Error('LB1 requires the loopback fixture');
const api = createApi({ token });

function SourceBarFixture() {
    const [filter, setFilter] = useState<SourceBarFilter>();
    const [revision, setRevision] = useState(0);
    const [advancing, setAdvancing] = useState(false);
    const [clockError, setClockError] = useState(false);
    const query = new URLSearchParams({ limit: '24' });
    if (filter?.deviceId) query.set('deviceId', filter.deviceId);
    if (filter?.sourceId) query.set('sourceId', filter.sourceId);
    const { data, error } = useResource<{ items: OwnerBrowseEntry[] }>(api, '/api/library/browse?' + query);

    async function advanceContactClock() {
        setAdvancing(true);
        setClockError(false);
        try {
            await api.request('/api/fixture/lb1/advance-contact', { method: 'POST' });
            setRevision(1);
        } catch {
            setClockError(true);
        } finally {
            setAdvancing(false);
        }
    }

    return <main style={{ maxWidth: 800, margin: 'auto', padding: 16 }}>
        <SourceBar api={api} serverUrl={location.origin} filter={filter} onFilterChange={setFilter} revision={revision}/>
        {error ? <p role="alert">夹具资料读取失败</p> : <ul aria-label="夹具资料">
            {data?.items.map(item => <li key={item.ref}>
                {item.entryType === 'material' ? item.material.title : item.capture.textPreview}
            </li>)}
        </ul>}
        <button className="button" type="button" disabled={advancing || revision > 0} onClick={() => void advanceContactClock()}>
            推进夹具时钟
        </button>
        {clockError && <p role="alert">夹具时钟更新失败</p>}
    </main>;
}

createRoot(document.getElementById('root')!).render(<SourceBarFixture/>);
