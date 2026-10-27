import {recordingBindingText,recordingSyncText} from './recording-status';
import {RecordingAuthorization} from './RecordingAuthorization';
import { formatEvidenceRef } from '@mote/shared';
import {ListPagination,useCursorPages} from './ListPagination';
import {ArchivedFileButton} from './ArchivedFileButton';
import { ArchivedAudio } from './ArchivedAudio';
import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { moteText } from '@mote/shared/i18n';
import type { RecordingStatus, RecordingSelection } from '@mote/shared';
import { type Api, errorMessage } from './api';
import { useResource } from './useResource';
import { useHashChoice } from './useHashChoice';
import { SourceContextFields, useSourceContextDraft } from './SourceContextEditor';
import { useUnsavedChanges } from './unsaved';
const readProvider=(hash:string)=>new URLSearchParams(hash.slice(hash.indexOf('?')+1)).get('provider')??'';
const names: Record<string, string> = { feishu: '飞书录音 / 妙记', dingtalk: '钉钉录音 / 闪记' };
const phases: Record<string, string> = { discover: '发现记录', metadata: '读取信息', transcript: '归档转写', media: '备份音频' };
const states: Record<string, string> = { waiting: '等待处理', running: '正在处理…', succeeded: '已完成', failed: '未完成', blocked: '需要处理', cancelled: '已取消', stale: '已过期' };
const errors: Record<string, string> = {
    lark_cli_missing: '中央节点需要安装 Lark CLI 并完成飞书账号授权。',
    lark_not_connected: '请先在中央节点完成飞书账号授权，再连接录音。',
    dingtalk_cli_missing: '中央节点需要安装 DWS CLI 并完成钉钉账号授权。',
    dingtalk_not_connected: '请先在中央节点完成钉钉账号授权，再连接录音。',
    recording_account_changed: '账号已变化，请重新连接并确认同步范围。',
    recording_authorization_required: '读取权限不足或授权已失效，请重新连接后重试。',
    recording_transcript_not_ready: '厂商转写尚未就绪。',
    recording_transcript_format_unsupported: '厂商转写格式尚不支持。音频备份是独立步骤，请分别核对转写与音频的状态。',
    unsupported_format: '厂商转写格式尚不支持。音频备份是独立步骤，请分别核对转写与音频的状态。',
};
const problem = (code: string,phase?:string) => errors[code]&&(code!=='unsupported_format'||phase==='transcript')?moteText(errors[code]):moteText('同步未完成（原因代码：{0}）。请查看同步步骤，核对实际原因后再重试。',code);
function RecordingSteps({api,path}:{api:Api;path:string}){
    const paging=useCursorPages(),read=useResource<{items:RecordingStatus['steps'];nextCursor:number|null}>(api,path+'/steps?limit=20'+(paging.cursor?'&cursor='+paging.cursor:''),3000);
    return <>{read.error&&<p role="alert">{errorMessage(read.error)}</p>}<div className="discovery-bounded-list" role="region" aria-label={moteText("同步步骤与状态明细")} tabIndex={0}>{read.data?.items.map(step=><Step key={step.id} step={step}/>)}</div><ListPagination label={moteText('步骤分页')} paging={paging} nextCursor={read.data?.nextCursor} count={read.data?.items.length??0} loading={read.loading}/></>;
}
function Step({step}:{step:RecordingStatus['steps'][number]}){
    return <p>{step.title&&<strong>{step.title} · </strong>}{phases[step.phase]?moteText(phases[step.phase]):step.phase} · {states[step.state]?moteText(states[step.state]):step.state} · {moteText('尝试 {0} 次',step.attempts)}{step.error&&<> · {problem(step.error,step.phase)} <code className="discovery-technical-id">{step.error}</code></>}{step.state==='waiting'&&Boolean(step.availableAt)&&step.availableAt!>Date.now()&&<> · {moteText('下次可运行时间')} {new Date(step.availableAt!).toLocaleString()}</>}{step.state==='failed'&&<> · {moteText('自动重试已停止，请核对原因后手动重试')}</>}</p>;
}
const inputTime = (value?: string) => {
    if (!value) return '';
    const date = new Date(value), pad = (part: number) => String(part).padStart(2, '0');
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
export function RecordingConnection({ api, provider, onOpen }: {
    api: Api;
    provider: string;
    onOpen: (ref: string) => void;
}) {
    const path = `/api/connectors/${provider}-recordings`, read = useResource<RecordingStatus>(api, path, 3000);
    const archive = useResource<{
        items: {
            id: string;
            captureId?: string;
            empty?: boolean;
            unsupported?: boolean;
            export?: {id:string;name:string};
            title: string;
            audio?: {
                id: string;
                name: string;
                mimeType: string;
            };
        }[];
    }>(api, read.data?.connected ? path + '/items?includeExports=true' : null, 10000);
    const [selection, setSelection] = useState<RecordingSelection>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [stepsOpen,setStepsOpen]=useState(false);
    // Preserve native partial-year drafts until the validated form is submitted.
    const [range, setRange] = useState({ start: '', end: '' });
    const acceptSelection = (next?: RecordingSelection) => {
        setSelection(next);
        setRange({ start: inputTime(next?.start), end: inputTime(next?.end) });
    };
    const dirty = useRef(false), running = useRef(false), scope = useRef(new AbortController());
    const context = useSourceContextDraft(api, read.data?.connected ? read.data.sourceId : undefined);
    useEffect(() => {
        const controller = new AbortController(); scope.current = controller;
        dirty.current = false; running.current = false; setBusy(false); setError(''); setSaved(false); acceptSelection(read.data?.selection);
        return () => controller.abort();
    }, [api, provider, read.data?.sourceId]);
    useEffect(() => { if (read.data && !dirty.current)
        acceptSelection(read.data.selection); }, [read.data]);
    const update = (patch: Partial<RecordingSelection>) => { dirty.current = true; setSaved(false); setSelection(v => v ? { ...v, ...patch } : v); };
    const updateRange = (field: 'start' | 'end', value: string) => { dirty.current = true; setSaved(false); setRange(v => ({ ...v, [field]: value })); };
    const rangeChanged = Boolean(selection && (range.start !== inputTime(selection.start) || range.end !== inputTime(selection.end)));
    const selectionChanged = rangeChanged || Boolean(selection && read.data && (['enabled', 'start', 'end', 'autoSync', 'backupAudio'] as const).some(key => selection[key] !== read.data!.selection[key]));
    const changed = selectionChanged || context.dirty;
    useUnsavedChanges(changed);
    const run = async (method: string, suffix = '', body?: unknown) => { if (running.current) return; const signal = scope.current.signal; running.current = true; setBusy(true); setError(''); setSaved(false); try {
        const next = await api.request<RecordingStatus>(path + suffix, { method, signal, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!signal.aborted) {
            if (suffix === '/connect' || method === 'DELETE') {
                dirty.current = false;
                acceptSelection(next.selection);
            }
            read.refresh();
        }
    }
    catch (e) {
        if (!signal.aborted)
            setError(e instanceof Error && Object.hasOwn(errors,e.message) ? problem(e.message) : errorMessage(e));
    }
    finally {
        if (scope.current.signal === signal) running.current = false;
        if (!signal.aborted)
            setBusy(false);
    } };
    const save = async () => {
        if (running.current || !selection) return;
        const signal = scope.current.signal;
        running.current = true; setBusy(true); setError(''); setSaved(false);
        try {
            // A source declaration must be acknowledged before enabling new intake.
            await context.save(signal);
            if (signal.aborted) return;
            if (selectionChanged) {
                const next = await api.request<RecordingStatus>(path + '/selection', { method: 'PUT', signal, body: JSON.stringify({ ...selection,
                    start: range.start === inputTime(selection.start) ? selection.start : new Date(range.start).toISOString(),
                    end: range.end === inputTime(selection.end) ? selection.end : range.end ? new Date(range.end).toISOString() : undefined,
                }) });
                if (signal.aborted) return;
                acceptSelection(next.selection);
            }
            dirty.current = false; setSaved(true); read.refresh();
        } catch (error) {
            if (!signal.aborted) setError(errorMessage(error));
        } finally {
            if (scope.current.signal === signal) running.current = false;
            if (!signal.aborted) setBusy(false);
        }
    };
    const status = read.data;
    return <section className="panel lark-step"><div className="section-heading"><h2>{names[provider]?moteText(names[provider]):status?.label ?? provider}</h2><span className="badge muted">{recordingBindingText(status)}</span></div>
 {Boolean(error || read.error) && <p role="alert" className="notice error">{error || errorMessage(read.error)}</p>}
 {status && <p className="recording-sync-status">{recordingSyncText(status)}</p>}
 {status?.connected && <p className="muted">{moteText('已保存账号绑定不代表当前登录或读取权限有效。“重新检测”检查中央运行环境；请结合授权结果与同步步骤确认账号权限。')}</p>}
 {status?.authorization&&<RecordingAuthorization key={provider} api={api} provider={provider}/>}
 {status?.accountName && <p>{status.accountName}</p>}{!status?.connected && !status?.authorization && <div className="discovery-inline-guidance"><p>{moteText("先在中央节点授权厂商账号，确认所需读取权限，再选择历史范围并启用同步。飞书文档与日历的授权另在自己的页面管理。")}</p></div>}
 {!status?.connected && <><p>{status?.authorization?moteText('授权完成后，确认历史范围并启用同步。'):moteText('连接中央节点已经授权的厂商账号，然后选择首次导入时间。')}</p><button className="button" disabled={busy || !status} onClick={() => void run('POST', '/connect')}>{moteText('连接已授权账号')}</button>
{status?.setup && <details><summary>{moteText('首次授权帮助')}</summary><p>{status.setup.description}</p>{status.setup.command && <code>{status.setup.command}</code>}{status.setup.documentationUrl?.startsWith('https://') && <p><a href={status.setup.documentationUrl} target="_blank" rel="noreferrer">{status.label ?? provider}</a></p>}</details>}</>}
 {status?.connected && selection && <form className="recording-scope-form" onSubmit={e => {
     e.preventDefault();
     void save();
 }}><fieldset disabled={busy}><div className="lark-range"><label>{moteText('首次历史导入起点')}<input type="datetime-local" required value={range.start} onChange={e => updateRange('start', e.target.value)}/></label><label>{moteText('导入终点（留空持续同步）')}<input type="datetime-local" value={range.end} onChange={e => updateRange('end', e.target.value)}/></label></div>
 <label className="lark-check"><input type="checkbox" checked={selection.enabled} onChange={e => update({ enabled: e.target.checked })}/>{moteText('启用录音同步')}</label><label className="lark-check"><input type="checkbox" checked={selection.autoSync} onChange={e => update({ autoSync: e.target.checked })}/>{moteText('在后台定期同步选中内容')}</label>
 {status.sourceId && <SourceContextFields draft={context} disabled={busy}/>}
 <div className="recording-save-bar"><button className="button primary" type="submit" disabled={!changed || context.busy || Boolean(status.sourceId && !context.ready)}>{busy ? moteText('正在保存…') : selectionChanged && selection.enabled ? moteText('保存并开始同步') : moteText('保存设置')}</button>{changed ? <span className="muted">{moteText('有未保存的修改，仅保留在当前页面')}</span> : saved && <span role="status">{moteText('设置已保存。')}</span>}</div>
 <div className="lark-buttons"><button className="button subtle" type="button" disabled={!selection.enabled || changed} onClick={() => void run('POST', '/sync')}><RefreshCw size={15}/>{moteText('立即同步')}</button><button className="button subtle" type="button" disabled={!status.counts.failed} onClick={() => void run('POST', '/retry')}>{moteText('重试失败步骤')}</button><button className="button subtle" type="button" onClick={() => void run('DELETE')}>{moteText('断开连接')}</button></div></fieldset></form>}
 {status && <><p role="status">{moteText('已归档转写 {0} 条，音频 {1} 条；等待 {2} 步，需处理 {3} 步。', status.counts.transcripts, status.counts.audio, status.counts.pending, status.counts.failed)}</p>
 {Boolean(status.counts.empty)&&<p role="status">{moteText('采集完成，暂无文字：{0} 条',status.counts.empty!)}</p>}
 {status.counts.failed > 0 && <div className="notice error" role="alert"><p>{status.counts.failed}{' '}{moteText("个步骤需要处理。")}{' '}{moteText("核对原因后，可使用上方「重试失败步骤」。转写与音频状态分别核对。")}</p>{status.steps.filter(step=>['failed','blocked'].includes(step.state)).map(step=><Step key={step.id} step={step}/>)}</div>}<details className="discovery-bounded-details" onToggle={e=>setStepsOpen(e.currentTarget.open)}><summary>{moteText('同步步骤与状态')} · {status.stepsTotal??status.steps.length}{' '}{moteText("项")}</summary>{stepsOpen&&<RecordingSteps api={api} path={path}/>}</details></>}

 {Boolean(archive.data?.items.length) && <details className="discovery-bounded-details"><summary>{moteText('最近归档的录音')} · {archive.data!.items.length}{' '}{moteText("条")}</summary><div className="discovery-bounded-list" role="region" aria-label={moteText("最近归档的录音列表")} tabIndex={0}>{archive.data!.items.map(item => <div className="source-item" key={item.id}>{item.captureId?<button className="text-button" onClick={() => onOpen(formatEvidenceRef('capture', item.captureId!))}>{item.title || moteText('原始录音')}</button>:<strong>{item.title || moteText('原始录音')}</strong>}{item.empty&&<p>{moteText('采集完成，暂无文字')}</p>}{item.unsupported&&<p>{moteText('厂商转写格式尚不支持')}</p>}{item.export&&<ArchivedFileButton api={api} id={item.export.id} name={item.export.name}/>}{item.audio && <ArchivedAudio api={api} id={item.audio.id} name={item.audio.name} mimeType={item.audio.mimeType}/>}</div>)}</div></details>}
 </section>;
}
export function RecordingsSettings({ api, onSources, onOpen, onAdd }: {
    api: Api;
    onSources: () => void;
    onOpen: (ref: string) => void;
    onAdd?: () => void;
}) {
    const registry = useResource<Record<string, RecordingStatus>>(api, '/api/connectors/status');
    const providers = Object.values(registry.data ?? {}).filter(status => status?.category === 'recordings');
    const [selected]=useHashChoice('provider',readProvider);
    const chosen = providers.find(status => status.provider === selected);
    return <div className="lark-settings">{onAdd && <button className="back-link" onClick={onAdd}>{moteText("← 返回数据源目录")}</button>}<div className="page-heading"><h1>{chosen ? names[chosen.provider]?moteText(names[chosen.provider]):chosen.label ?? chosen.provider : moteText('录音归档')}</h1><p>{moteText('照常使用录音笔。厂商完成上传和转写后，Mote 自动归档并生成可追溯的 Memory。')}</p></div><div className="lark-boundary"><p>{moteText('默认用转写生成洞察，原始音频在后台备份。厂商端删除后，Mote 归档继续保留。停止同步或断开连接会保留历史资料。')}</p></div><div className="discovery-recorder-steps"><span><b>1</b>{moteText("准备厂商账号与读取授权")}</span><span><b>2</b>{moteText("确认历史范围并启用同步")}</span><span><b>3</b>{moteText("查看转写归档与音频备份状态")}</span></div>{Boolean(registry.error) && <p role="alert">{errorMessage(registry.error)}</p>}
 {chosen ? <RecordingConnection key={chosen.provider} api={api} provider={chosen.provider} onOpen={onOpen}/> : <><div className="discovery-source-grid">{providers.map(status => <a className="panel discovery-source-card" key={status.provider} href={'#/connections/recordings?provider=' + encodeURIComponent(status.provider)}><h2>{names[status.provider]?moteText(names[status.provider]):status.label ?? status.provider}</h2><p>{recordingBindingText(status)}</p><p className="recording-sync-status">{recordingSyncText(status)}</p><span className="discovery-card-action">{moteText("打开此录音来源 →")}</span></a>)}</div>{selected && registry.data && <p role="status">{moteText("该录音来源当前未注册。请重新选择可用来源；已归档资料仍可从资料库查看。")}</p>}</>}
 <button className="button subtle" onClick={onSources}>{moteText('查看来源与归档')}</button></div>;
}
