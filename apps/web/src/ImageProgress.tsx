import { failureMessage } from './failure-message';
import { useEffect, useRef, useState } from 'react';
import { moteText } from '@mote/shared/i18n';
import { type Api, ApiError, errorMessage } from './api';
import { useResource } from './useResource';
import { resources } from './resource-cache';
type View = {
    exclusion?: string;
    wait: 'running' | 'unknown' | null;
    original: {
        state: string;
    };
    automatic: boolean;
    understandingEnabled: boolean;
    policy?: {
        profile: {
            name: string;
            processorId: string;
        };
    };
    jobs: {
        name: string;
        state: string;
        error?: string | null;
    }[];
    products: {
        id: string;
        name: string;
        kind: string;
        text: string;
        generatedAt: string;
    }[];
    materials: {
        id: string;
        state: string;
    }[];
    memory: {
        state: string;
        count: number;
        error?: string | null;
    }[];
};
const states: Record<string, string> = { skipped: '已跳过', ready: '已就绪', indexed: '已就绪', succeeded: '已完成', completed: '已完成', pending: '等待处理', waiting: '等待处理', queued: '等待处理', running: '处理中', blocked: '需要处理，查看具体原因', failed: '处理失败', cancelled: '已取消', unavailable: '原件不可用', disabled: '未安排', not_scheduled: '未安排', waiting_for_input: '等待资料', waiting_for_model: '等待模型配置', paused: '已暂停', stale: '来源变化待重验' };
function imageFailure(code?:string|null) {
    if (code === 'background_model_authorization_required') return moteText('等待开启自动处理');
    if (code === 'image_worker_unavailable') return moteText('本机处理未能启动，请重试。');
    if (code === 'image_processing_failed') return failureMessage('provider_failed');
    if (['invalid_image_product','invalid_image_region','image_protocol_version_mismatch'].includes(code ?? '')) return failureMessage('agent_response');
    return failureMessage(code);
}
export function ImageProgress({ api, id }: {
    api: Api;
    id: string;
}) {
    const path = '/api/images/' + encodeURIComponent(id);
    const read = useResource<View>(api, path, 5000), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmation, setConfirmation] = useState<{api:Api;id:string}>();
    const visit = useRef({api,id,alive:true,busy:false});
    if (visit.current.api !== api || visit.current.id !== id) {
        visit.current.alive = false;
        visit.current = {api,id,alive:true,busy:false};
    }
    const own = visit.current;
    useEffect(() => { own.alive = true; setBusy(false); setError(''); setConfirmation(undefined); return () => { own.alive = false; }; }, [own]);
    useEffect(() => { if (read.data?.wait !== 'unknown') setConfirmation(undefined); }, [read.data?.wait]);
    const confirmUnknown = confirmation?.api === api && confirmation.id === id;
    if (read.error instanceof ApiError && read.error.status === 404)
        return null;
    if (!read.data?.original)
        return read.error ? <p role="alert">{errorMessage(read.error)} <button type="button" className="text-button" onClick={read.refresh}>{moteText('刷新')}</button></p> : null;
    const value = read.data, archive = value.policy?.profile.processorId === 'archive';
    const label = (state: string) => moteText(states[state] ?? '处理未完成');
    const phase = (name: string) => {
        const job = value.jobs.find(j => j.name === name), product = value.products.find(p => p.name === name);
        if (value.exclusion) return moteText('已跳过');
        if (product) return moteText('已就绪') + (job && job.state !== 'succeeded' ? ' · ' + label(job.state) : '');
        if (job) return label(job.state);
        if (archive || name === 'understanding' && !value.understandingEnabled) return moteText('未安排');
        return value.automatic ? moteText('等待处理') : moteText('历史未安排');
    };
    const unavailable = busy || read.loading || read.error !== undefined;
    const cannotRetry = unavailable || value.wait === 'running' || value.wait === 'unknown' && !confirmUnknown;
    async function action(suffix: string, body: unknown) { if (own.busy || read.loading || read.error !== undefined) return; own.busy = true; setBusy(true); setError(''); setConfirmation(undefined); try {
        await api.request(path + '/' + suffix, { method: 'POST', body: JSON.stringify(body) });
    }
    catch (error) {
        if (own.alive && visit.current === own) setError(errorMessage(error));
    }
    finally {
        own.busy = false;
        resources(api).invalidate(key => key === path);
        if (own.alive && visit.current === own) setBusy(false);
    } }
    return <section className="policy-card image-progress" style={{minWidth:0,maxWidth:'100%',overflowWrap:'anywhere'}} aria-label={moteText('图片处理进度')}><h3>{moteText('图片处理进度')}</h3>{value.policy && <p>{moteText('中央图片方案')} · {value.policy.profile.name}</p>}
 <dl><dt>{moteText('原件')}</dt><dd>{label(value.original.state)}</dd><dt>{moteText('文字识别')}</dt><dd>{phase('ocr')}</dd><dt>{moteText('内容理解')}</dt><dd>{phase('understanding')}</dd><dt>{moteText('资料索引')}</dt><dd>{value.materials.length ? value.materials.map(m => label(m.state)).join(' / ') : moteText('等待资料')}</dd><dt>{moteText("记忆（Memory）")}</dt><dd>{value.memory.length ? value.memory.map(m => m.state === 'completed' && m.count === 0 ? moteText('已完成，未生成新记忆') : label(m.state)).join(' / ') : moteText('未安排')}</dd></dl>
 {value.exclusion && <p>{failureMessage(value.exclusion)}</p>}
 {value.products.filter(p => p.kind !== 'ocr').map(p => <details key={p.id}><summary>{p.name === 'understanding' ? moteText('查看图片理解') : p.name}</summary><p>{moteText('以下为模型解释，原图与 OCR 是原始证据。')}</p><pre className="library-original-text">{p.text}</pre></details>)}
 {value.jobs.filter(j => !value.exclusion && j.error && j.state !== 'succeeded').map(j => <div className="discovery-step-reason" key={j.name}>{j.name === 'ocr' ? moteText('文字识别') : j.name === 'understanding' ? moteText('内容理解') : j.name} · {label(j.state)} <span>{imageFailure(j.error)}</span>{['model_unconfigured', 'model_not_configured', 'provider_not_configured'].includes(j.error!) ? <a className="text-button" href="#/system/models?category=providers">{moteText("检查模型连接 →")}</a> : ['model_missing', 'not_installed','image_worker_unavailable'].includes(j.error!) ? <a className="text-button" href="#/system/models?category=images">{moteText("查看图片处理设置 →")}</a> : null}<details><summary>{moteText("原因代码")}</summary><code>{j.error}</code></details></div>)}
 {value.memory.filter(m => m.error).map((m,index) => <p key={index}>{moteText('记忆（Memory）')} · {label(m.state)} · {imageFailure(m.error)}</p>)}
 {!value.exclusion && value.wait === 'unknown' && <label><input type="checkbox" checked={confirmUnknown} disabled={unavailable} onChange={e => setConfirmation(e.target.checked ? {api,id} : undefined)}/>{moteText('上次处理是否结束未知，重试可能重复执行。请确认后继续。')}</label>}{error && <p role="alert">{error}</p>}{read.error !== undefined && <p role="alert">{errorMessage(read.error)} <button type="button" className="text-button" onClick={read.refresh}>{moteText('刷新')}</button></p>}{!value.exclusion && <div className="source-toolbar" style={{flexWrap:'wrap'}}><button className="button primary" disabled={cannotRetry} onClick={() => void action('retry', { mode: 'complete', confirmUnknown })}>{moteText('补齐未完成步骤')}</button><button className="button" disabled={cannotRetry} onClick={() => void action('retry', { mode: 'recompute', confirmUnknown })}>{moteText('重新计算已有结果')}</button>{value.jobs.some(j => ['waiting', 'running', 'blocked', 'failed'].includes(j.state)) && <button className="button" disabled={unavailable} onClick={() => void action('cancel', {})}>{moteText('停止处理')}</button>}</div>}</section>;
}
