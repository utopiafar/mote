import {invalidateConfiguration} from './configuration-cache';
import { useResource } from './useResource';
import { MemoryRecipeSelection } from './MemoryRecipeSelection';
import { ApiError } from './api';
import { useUnsavedChanges } from './unsaved';
import { moteText } from '@mote/shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { type Api, errorMessage, dateTime } from './api';
type Policy = {
    enabled: boolean;
    intervalHours: number;
    maxWaitHours?: number;
    minChanges: number;
    maxItems: number;
};
type Settings = {
    drainWindows: number;
    extraction: Policy;
    consolidation: Policy;
    insights: Policy;
    working: Policy;
    batchCharacters: number;
    recentTurns: number;
    contextCharacters: number;
    summaryCharacters: number;
};
type View = {
    revision: number;
    settings: Settings;
    extensions: {
        id: string;
        version: string;
        status: string;
        pendingChanges: number;
        dueAt: number;
        failures: number;
        maxAttempts?: number;
        manualRetryRequired?: boolean;
        cursor: number;
        active?: {
            id: string;
        };
    }[];
};
const names = { extraction: "资料记忆提取", consolidation: "长期记忆整理", insights: "周期洞察", working: "对话工作记忆" };
const statuses: Record<string, string> = { disabled: "已关闭", pending: "处理中或等待重试", waiting_for_model: "等待配置模型", waiting_for_interval: "等待周期", waiting_for_increment: "等待新增变化", retry_wait: '等待自动重试', queued: '排队等待执行名额', running: '正在执行', paused: '已暂停', pausing: '当前批次结束后暂停', cancelled: '已取消', failed: '失败，等待重试', ready: "等待下一次检查" };
const enabledNames = { consolidation: '启用长期记忆自动整理', insights: '启用周期洞察', working: '启用对话工作记忆' };
const enabledLabel = (id: keyof typeof enabledNames) => moteText(enabledNames[id]);
export function MemorySettings({ api, onPlans }: {
    api: Api;
    onPlans?: () => void;
}) {
    const read = useResource<View>(api, '/api/memory-settings', 5000), view = read.data;
    const [editor, setEditor] = useState<{
        api: Api;
        draft: Settings;
        baseline: Settings;
        revision: number;
    }>(), [error, setError] = useState(''), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false);
    const active = editor?.api === api ? editor : undefined, draft = active?.draft, dirty = !!active && JSON.stringify(active.draft) !== JSON.stringify(active.baseline), request = useRef<AbortController | null>(null);
    const setDraft = (value: Settings) => setEditor(current => current?.api === api ? { ...current, draft: value } : current);
    useUnsavedChanges(dirty);
    useEffect(() => { setError(''); setSaved(false); setBusy(false); return () => request.current?.abort(); }, [api]);
    useEffect(() => { if (read.data && !dirty)
        setEditor({ api, draft: read.data.settings, baseline: read.data.settings, revision: read.data.revision }); if (read.error instanceof ApiError && [401, 403, 404, 410].includes(read.error.status))
        setEditor(undefined); }, [api, read.data, read.error]);
    async function save() { if (!draft || busy)
        return; const controller = new AbortController(); request.current = controller; setBusy(true); setSaved(false); setError(''); try {
        const v = await api.request<View>('/api/memory-settings', { method: 'PUT', body: JSON.stringify({revision:active!.revision,settings:draft}), signal: controller.signal });
        if (controller.signal.aborted)
            return;
        setEditor({ api, draft: v.settings, baseline: v.settings, revision: v.revision });
        setSaved(true);
        invalidateConfiguration(api);
    }
    catch (e) {
        if (!controller.signal.aborted)
            setError(errorMessage(e));
    }
    finally {
        if (!controller.signal.aborted)
            setBusy(false);
    } }
    async function retryExtraction(id: string) { if (busy || dirty)
        return; const controller = new AbortController(); request.current = controller; setBusy(true); setSaved(false); setError(''); try {
        await api.request(`/api/memory-settings/extraction/${encodeURIComponent(id)}/retry`, { method: 'POST', signal: controller.signal });
        if (!controller.signal.aborted)
            read.refresh();
    }
    catch (e) {
        if (!controller.signal.aborted)
            setError(errorMessage(e));
    }
    finally {
        if (!controller.signal.aborted)
            setBusy(false);
    } }
    return <section className="panel memory-settings"><div className="section-heading"><div><h2>{moteText("记忆与洞察的节奏")}</h2><p>{moteText("历史资料提取、长期整理与对话工作记忆达到增量门槛或最大等待时间时运行；自动洞察需要周期与增量门槛同时达到。窗口任务每分钟检查一次，进行中的窗口沿用启动时的设置。")}</p></div></div>
    <div className="discovery-inline-guidance"><p>{moteText("这里配置模型、提取配方和历史资料的处理节奏。自动记忆的暂停 / 恢复、当前方案和更换方案，在「设置 → 自动记忆与插件 → 记忆方案」管理。")}</p>{onPlans && <a className="text-button" href="#/system/plugins?tab=memory">{moteText("管理自动记忆与当前方案 →")}</a>}</div>
    {Boolean(error || read.error) && <p className="notice error" role="alert">{error || errorMessage(read.error)}</p>}{saved && <p role="status">{moteText("设置已保存。")}</p>}
    {draft && <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <MemoryLifecycleFields draft={draft} setDraft={value=>{setSaved(false);setDraft(value);}} busy={busy} view={view} dirty={dirty} onRetry={retryExtraction}/>
      <p>{moteText("记忆以文本保存，可按需查看概览、内容与边界、原始证据。通过自动审核和证据校验后直接生效，你可以随时纠正或删除。历史资料提取按窗口处理已圈定的积压，每轮窗口上限控制成本。")}</p><button className="button primary" disabled={busy} type="submit">{busy ? moteText("正在保存…") : moteText("保存记忆设置")}</button>{error&&<button className="button subtle" type="button" disabled={busy} onClick={()=>{setEditor(undefined);setError('');read.refresh();}}>{moteText('重新读取并还原草稿')}</button>}
    </form>}
    <MemoryRecipeSelection api={api}/>
  </section>;
}

/** The same form controls edit M04’s personal lifecycle document. Runtime
 * window status is rendered only when the caller has that actual projection. */
export function MemoryLifecycleFields({draft,setDraft,busy=false,view,dirty=false,onRetry}:{draft:Settings;setDraft:(value:Settings)=>void;busy?:boolean;view?:View;dirty?:boolean;onRetry?:(id:string)=>Promise<void>}){
 return <>
      {(Object.keys(names) as (keyof typeof names)[]).map(id => { const p = draft[id], state = view?.extensions.find(e => e.id === id), terminal = id === 'extraction' && state?.status === 'failed'; return <fieldset key={id} disabled={busy}><legend>{moteText(names[id])}</legend>{id === 'extraction' ? <p>{moteText('这些提取门槛与最大等待时间只控制历史资料的窗口处理。已授权且内容就绪的新资料直接进入自动记忆队列，按可用名额持续处理。')}</p> : <label><input type="checkbox" aria-label={enabledLabel(id)} checked={p.enabled} onChange={e => { setDraft({ ...draft, [id]: { ...p, enabled: e.target.checked } }); }}/>{enabledLabel(id)}</label>}<div className="memory-settings-grid">{([[id === 'insights' ? 'intervalHours' : 'maxWaitHours', id === 'insights' ? moteText("最短周期（小时）") : moteText("最大等待（小时）"), 1 / 60, 8760], ['minChanges', id === 'working' ? moteText("新增对话轮次") : moteText("新增变化数"), 1, 100000], ['maxItems', moteText("每个窗口最多处理变化"), 1, id === 'consolidation' ? 50 : 2000]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} step={key === 'maxWaitHours' || key === 'intervalHours' ? 'any' : 1} required value={p[key] ?? Math.min(p.intervalHours, 1)} onChange={e => { setDraft({ ...draft, [id]: { ...p, [key]: Number(e.target.value) } }); }}/></label>)}</div>{state && <p className="muted">{terminal ? (state.manualRetryRequired ? moteText("需要处理") : moteText("已停止")) : statuses[state.status]?moteText(statuses[state.status]):state.status}{' '}{moteText("· 待处理")}{' '}{state.pendingChanges}{' '}{moteText("次变化 · 周期到达时间")}{' '}{dateTime(new Date(state.dueAt).toISOString())}{terminal ? (state.manualRetryRequired ? moteText("操作未完成，请检查权限与配置后重试") : moteText("资料记忆提取已停止自动重试：失败 {0}/{1} 次。检查配置后可手动重试。", state.failures, state.maxAttempts ?? state.failures)) : state.failures > 0 ? moteText(" · 已失败 {0} 次，自动退避重试", state.failures) : ''}</p>}{terminal && state?.active && <button type="button" className="button secondary" disabled={dirty} onClick={() => void onRetry?.(state.active!.id)}>{moteText("重试")}</button>}</fieldset>; })}
      <fieldset disabled={busy}><legend>{moteText("每次披露的内容量")}</legend><div className="memory-settings-grid">{([['drainWindows', moteText("每轮积压处理窗口上限"), 1, 1000], ['batchCharacters', moteText("提取批次字符上限"), 256, 12000], ['recentTurns', moteText("至少保留近期对话轮数"), 2, 20], ['contextCharacters', moteText("对话上下文字符上限"), 4000, 60000], ['summaryCharacters', moteText("工作记忆字符上限"), 1000, 12000]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} step="1" required value={draft[key]} onChange={e => { setDraft({ ...draft, [key]: Number(e.target.value) }); }}/></label>)}</div></fieldset>
 </>;
}
