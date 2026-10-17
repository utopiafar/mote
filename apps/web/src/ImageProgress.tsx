import { failureMessage } from './failure-message';
import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { readImageRetry, saveImageRetry, clearImageRetry } from './image-retry-intent';
import { moteText } from '@mote/shared/i18n';
import { type Api, ApiError, errorMessage } from './api';
import { useResource } from './useResource';
type View = {
    proof?: string;
    canCancel?: boolean;
    enabled?: boolean;
    processingRequired?: boolean;
    exclusion?: string;
    wait: 'running' | 'unknown' | null;
    original: {
        state: string;
    };
    automatic: boolean;
    understandingEnabled: boolean;
    ocrEnabled?: boolean;
    policy?: {
        profile: {
            name: string;
            processorId: string;
        };
    };
    jobs: {
        name: string;
        state: string;
        error?: string;
    }[];
    products: {
        id: string;
        name: string;
        kind: string;
        stepName?: string;
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
        error?: string;
    }[];
};
const states: Record<string, string> = { skipped: '已跳过', ready: '已就绪', indexed: '已就绪', succeeded: '已完成', completed: '已完成', pending: '等待处理', waiting: '等待处理', queued: '等待处理', running: '处理中', blocked: '需要处理，查看具体原因', failed: '处理失败', cancelled: '已取消', unavailable: '原件不可用', disabled: '未安排', not_scheduled: '未安排', waiting_for_input: '等待资料', waiting_for_model: '等待模型配置', paused: '已暂停', stale: '来源变化待重验' };
type Props = {api: Api; id: string; onChanged?:()=>void};
export function ImageProgress(props: Props) {return <ImageProgressView key={JSON.stringify([props.api.connection,props.id])} {...props}/>;}
function ImageProgressView({ api, id, onChanged }: Props) {
    const read = useResource<View>(api, '/api/images/' + encodeURIComponent(id), 5000), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmUnknown, setConfirmUnknown] = useState(false);
    const request = useRef<AbortController | null>(null), alive = useRef(false), [pending, setPending] = useState<string>();
    useLayoutEffect(() => { alive.current = true; try { setPending(readImageRetry(api,id)); } catch(e) { setError(errorMessage(e)); } return () => {alive.current=false;request.current?.abort();}; }, [api,id]);
    const revoked = read.error instanceof ApiError && [401,403,404,410].includes(read.error.status);
    const publication = useRef<string|undefined>(undefined);
    useEffect(() => {
        if(!read.data?.original || revoked)return;
        const signature=JSON.stringify([read.data.proof,read.data.original.state,read.data.jobs,read.data.products.map(p=>p.id),read.data.materials.map(m=>m.id)]);
        if(publication.current===signature)return;publication.current=signature;onChanged?.();
    },[read.data,revoked,onChanged]);
    useLayoutEffect(() => {if(revoked){request.current?.abort();setBusy(false);setConfirmUnknown(false);}}, [revoked]);
    useLayoutEffect(() => {setConfirmUnknown(false);}, [read.data?.proof,read.data?.wait]);
    if (!read.data?.original || revoked)
        return read.error ? <p role="alert">{errorMessage(read.error)}<button className="button" onClick={read.refresh}>{moteText('重新读取')}</button></p> : null;
    const value = read.data, archive = value.processingRequired === false || value.policy?.profile.processorId === 'archive';
    const label = (state: string) => moteText(states[state] ?? '处理未完成');
    const phase = (name: string) => { const job = value.jobs.find(j => j.name === name), product = value.products.find(p => p.name === name); return value.exclusion ? moteText('已跳过') : archive || name === 'ocr' && value.ocrEnabled === false || name === 'understanding' && !value.understandingEnabled ? moteText('未安排') : job && job.state !== 'succeeded' ? label(job.state) : product ? moteText('已就绪') : value.enabled === false ? moteText('已暂停') : !value.automatic ? moteText('历史未安排') : moteText('等待处理'); };
    const locked = busy || read.loading || !!read.error;
    async function send(kind: 'retry' | 'cancel', body: string) {
        if(!alive.current || request.current || read.error) return;
        const controller=new AbortController();request.current=controller;setBusy(true);setError('');
        try {
            const result=await api.request<{queued?:boolean;taskId?:string}>('/api/images/' + encodeURIComponent(id) + '/' + kind, {method:'POST',body,signal:controller.signal});
            if(alive.current && !controller.signal.aborted){
                if(kind==='retry'){if(result.queued && !result.taskId)throw Error(moteText('服务返回的操作回执与当前账号不一致。'));clearImageRetry(api,id,body);setPending(undefined);}
                setConfirmUnknown(false);read.refresh();
            }
        } catch(e) {if(alive.current&&!controller.signal.aborted)setError(errorMessage(e));}
        finally {if(request.current===controller){request.current=null;if(alive.current)setBusy(false);}}
    }
    async function action(kind: 'retry' | 'cancel', body: object) {
        if(locked || pending || !value.proof) return;
        const payload=JSON.stringify({...body,proof:value.proof,...(kind==='retry'?{operationId:crypto.randomUUID()}:{})});
        if(kind==='retry'){try{saveImageRetry(api,id,payload);setPending(payload);}catch(e){setError(errorMessage(e));return;}}
        await send(kind,payload);
    }
    return <section className="policy-card image-progress" aria-label={moteText('图片处理进度')}><h3>{moteText('图片处理进度')}</h3>{value.policy && <p>{moteText('中央图片方案')} · {value.policy.profile.name}</p>}
 <dl><dt>{moteText('原件')}</dt><dd>{label(value.original.state)}</dd><dt>{moteText('文字识别')}</dt><dd>{phase('ocr')}</dd><dt>{moteText('内容理解')}</dt><dd>{phase('understanding')}</dd><dt>{moteText('资料索引')}</dt><dd>{value.materials.length ? value.materials.map(m => label(m.state)).join(' / ') : moteText('等待资料')}</dd><dt>{moteText("记忆（Memory）")}</dt><dd>{value.memory.length ? value.memory.map(m => m.state === 'completed' && m.count === 0 ? moteText('已完成，未生成新记忆') : label(m.state)).join(' / ') : moteText('未安排')}</dd></dl>
 {value.exclusion && <p>{failureMessage(value.exclusion)}</p>}
 {value.products.filter(p => p.kind !== 'ocr' || !!p.stepName).map(p => <details key={p.id}><summary>{p.kind === 'ocr' ? moteText('文字识别') : p.name === 'understanding' ? moteText('查看图片理解') : p.name}{p.stepName && ` · ${p.stepName}`}</summary>{p.kind !== 'ocr' && <p>{moteText('以下为模型解释，原图与 OCR 是原始证据。')}</p>}<pre className="library-original-text">{p.text}</pre></details>)}
 {value.jobs.filter(j => !value.exclusion && j.error && j.state !== 'succeeded').map(j => <div className="discovery-step-reason" key={j.name}>{j.name === 'ocr' ? moteText('文字识别') : j.name === 'understanding' ? moteText('内容理解') : j.name} · {label(j.state)} <span>{failureMessage(j.error)}</span>{['model_unconfigured', 'model_not_configured', 'provider_not_configured'].includes(j.error!) ? <a className="text-button" href="#/system/models?category=providers">{moteText("检查模型连接 →")}</a> : ['model_missing', 'not_installed'].includes(j.error!) ? <a className="text-button" href="#/system/models?category=images">{moteText("查看图片处理设置 →")}</a> : null}<details><summary>{moteText("原因代码")}</summary><code>{j.error}</code></details></div>)}
 {!value.exclusion && value.wait === 'unknown' && <label><input type="checkbox" checked={confirmUnknown} onChange={e => setConfirmUnknown(e.target.checked)}/>{moteText('上次处理是否结束未知，重试可能重复执行。请确认后继续。')}</label>}{(!!error || !!read.error) && <p role="alert">{error || errorMessage(read.error)}</p>}{pending && <div className="notice"><p>{moteText('提交结果待确认；重试会使用原操作，不会重新创建任务。')}</p><button className="button" disabled={locked} onClick={() => void send('retry',pending)}>{moteText('重试提交')}</button><button className="button" disabled={busy} onClick={() => {clearImageRetry(api,id,pending);setPending(undefined);read.refresh();}}>{moteText('移除本机待确认提交')}</button></div>}{!value.exclusion && !archive && <div className="source-toolbar"><button className="button primary" disabled={locked || !!pending || value.enabled === false || value.wait === 'running' || value.wait === 'unknown' && !confirmUnknown} onClick={() => void action('retry', { mode: 'complete', confirmUnknown })}>{moteText('补齐未完成步骤')}</button><button className="button" disabled={locked || !!pending || value.enabled === false || value.wait === 'running' || value.wait === 'unknown' && !confirmUnknown} onClick={() => void action('retry', { mode: 'recompute', confirmUnknown })}>{moteText('重新计算已有结果')}</button>{(value.canCancel ?? value.jobs.some(j => ['waiting', 'running', 'blocked', 'failed'].includes(j.state))) && <button className="button" disabled={locked || !!pending} onClick={() => void action('cancel', {})}>{moteText('停止处理')}</button>}</div>}</section>;
}
