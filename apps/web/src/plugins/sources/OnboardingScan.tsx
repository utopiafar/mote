import {useEffect, useRef, useState} from 'react';
import {X} from 'lucide-react';
import {
  onboardingStartInputSchema, onboardingStartResultSchema, onboardingViewSchema, pageHash, pageRoutes,
  type OnboardingCounts, type OnboardingStartInput, type SourceConnection,
} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {containDialogFocus} from '../../dialog-focus';
import {Loading} from '../../Loading';
import {useHashChoice} from '../../useHashChoice';
import {useResource} from '../../useResource';
import {connectionReadState} from './connection-services';

const scanPath = '/api/assistant/onboarding';
const recentScanKey = 'mote.connections.onboarding';
const runIdSchema = onboardingStartResultSchema.shape.id;

function runId(value: unknown) {
  const parsed = runIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readRun(hash: string) {
  return runId(new URLSearchParams(hash.split('?')[1]).get('onboarding'));
}

function recentScanId() {
  try {return runId(sessionStorage.getItem(recentScanKey));} catch {return null;}
}

function useScanRead(api: Api, id: string | null, poll?: number) {
  const read = useResource<unknown>(api, id ? `${scanPath}/${encodeURIComponent(id)}` : null, poll);
  const view = !read.error && read.data !== undefined ? onboardingViewSchema.safeParse(read.data) : undefined;
  return {view: view?.success ? view.data : undefined, loading: read.loading, refresh: read.refresh,
    failure: read.error ? connectionReadState(read.error) : view && !view.success ? 'failed' : undefined};
}

function scanSummary(counts: OnboardingCounts) {
  return moteText('{0} 个来源 · {1} 份资料 · {2} 条待确认 · {3} 个点子 · {4} 条动态',
    counts.sources, counts.materials, counts.memories, counts.ideas, counts.feed);
}

export function OnboardingScan({api, sources, disabled}: {api: Api; sources: readonly SourceConnection[]; disabled: boolean}) {
  const [editing, setEditing] = useState(false);
  const [addressId] = useHashChoice('onboarding', readRun);
  const latestId = addressId ?? recentScanId();
  const {view, failure, refresh} = useScanRead(api, latestId);
  const finished = view?.state === 'completed';
  return <section className="connection-card connection-scan" aria-labelledby="connection-scan-title" data-onboarding-summary>
    <div>
      <h2 id="connection-scan-title">{moteText('认识我')}</h2>
      {finished && <p>{moteText('上次')} · {scanSummary(view.counts)}</p>}
      {failure && <p role="status">{failure === 'expired' ? moteText('已失效') : failure === 'offline' ? moteText('没连上') : moteText('读取失败')}
        {failure !== 'expired' && <> <button className="text-button" onClick={refresh}>{moteText('重试')}</button></>}
      </p>}
    </div>
    {view && (view.state === 'pending' || view.state === 'running')
      ? <a className="button" href={pageHash('chat', {onboarding: latestId!})}>{moteText('查看进度')}</a>
      : <button className="button" type="button" disabled={disabled || !sources.length} onClick={() => setEditing(true)}>
        {finished ? moteText('再认识一次') : moteText('开始')}
      </button>}
    {editing && <ScanSelection api={api} sources={disabled ? [] : sources} close={() => setEditing(false)}/>}
  </section>;
}

function ScanSelection({api, sources, close}: {api: Api; sources: readonly SourceConnection[]; close: () => void}) {
  const panel = useRef<HTMLDivElement>(null);
  const active = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const cleanup = panel.current && containDialogFocus(panel.current, document.activeElement as HTMLElement | null);
    return () => {active.current?.abort(); cleanup?.();};
  }, [api]);
  const input = onboardingStartInputSchema.safeParse({sources: selected, window: {days: Number(days)}});
  const available = new Set(sources.map(source => source.id));
  const editable = input.success && selected.every(id => available.has(id));

  async function start(selection: OnboardingStartInput) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      // CT1 defines source and window admission. The older material-based
      // endpoint cannot admit this selection until the CN2 contract ships.
      const raw = await api.request<unknown>(scanPath, {
        method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]), body: JSON.stringify(selection),
      });
      controller.signal.throwIfAborted();
      const {id} = onboardingStartResultSchema.parse(raw);
      try {sessionStorage.setItem(recentScanKey, id);} catch { /* The chat link still carries the run ID. */ }
      window.location.hash = pageHash('chat', {onboarding: id});
      close();
    } catch {
      if (!controller.signal.aborted) setError(moteText('未能开始认识我'));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (active.current === controller) active.current = null;
    }
  }

  return <div className="source-dialog-overlay" onKeyDown={event => {if (event.key === 'Escape' && !busy) close();}}>
    <div ref={panel} className="source-dialog connection-scan-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-scan-dialog-title">
      <header><h2 id="connection-scan-dialog-title">{moteText('认识我')}</h2>
        <button className="icon-button" type="button" disabled={busy} aria-label={moteText('关闭')} onClick={close}><X size={18}/></button>
      </header>
      <form onSubmit={event => {event.preventDefault(); if (editable) void start(input.data);}}>
        <fieldset disabled={busy}><legend>{moteText('来源')}</legend>
          {sources.map(source => <label key={source.id}><input name="sources" type="checkbox" value={source.id}
            checked={selected.includes(source.id)} disabled={selected.length >= 50 && !selected.includes(source.id)}
            onChange={event => setSelected(ids => event.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id))}/>{source.name}</label>)}
        </fieldset>
        <label>{moteText('最近天数')} <input name="days" type="number" min="1" max="365" placeholder="1–365" required disabled={busy}
          value={days} onChange={event => setDays(event.target.value)}/></label>
        {error && <p role="alert">{error}</p>}
        <footer><button className="button" type="button" disabled={busy} onClick={close}>{moteText('取消')}</button>
          <button className="button primary" type="submit" disabled={!editable || busy}>{moteText('开始')}</button>
        </footer>
      </form>
    </div>
  </div>;
}

function readChatRun(hash: string) {
  return hash.split('?')[0] === '#/' + pageRoutes.chat ? readRun(hash) : null;
}

export function OnboardingChatProgress({api}: {api: Api}) {
  const [id] = useHashChoice('onboarding', readChatRun);
  return id ? <ScanProgress key={id} api={api} id={id}/> : null;
}

function ScanProgress({api, id}: {api: Api; id: string}) {
  const [poll, setPoll] = useState(true);
  const {view, loading, failure, refresh} = useScanRead(api, id, poll ? 3000 : undefined);
  useEffect(() => {
    setPoll(!failure && (!view || view.state === 'pending' || view.state === 'running'));
  }, [failure, view]);
  const state = view?.state;
  const label = state && {
    pending: () => moteText('等待处理'), running: () => moteText('正在认识你'), completed: () => moteText('已完成'),
    failed: () => moteText('处理失败'), cancelled: () => moteText('已取消'),
  }[state]();
  return <div className="chat-card chat-progress" role="status" data-onboarding-chat-progress data-state={failure ?? state ?? 'loading'}>
    <strong>{moteText('认识我')}</strong>
    {failure ? <div>{failure === 'expired' ? moteText('已失效') : failure === 'offline' ? moteText('没连上') : moteText('读取失败')}
      {failure !== 'expired' && <> <button className="text-button" onClick={refresh}>{moteText('重试')}</button></>}
    </div> : view ? <div>{label} · {scanSummary(view.counts)}</div> : loading && <Loading rows={1}/>}
  </div>;
}
