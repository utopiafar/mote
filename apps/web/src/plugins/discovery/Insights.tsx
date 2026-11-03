import {InsightAutomaticSettings} from './InsightAutomaticSettings';
import { useResource } from '../../useResource';
import { useOperationUpdates } from '../../useOperationUpdates';
import { readResource, resources } from '../../resource-cache';
import { failureMessage } from '../../failure-message';
import { moteText } from '@mote/shared/i18n';
import { ModelSelector } from '../../ModelSelector';
import { useEffect, useRef, useState } from 'react';
import { InsightProgress, type InsightRun } from './InsightProgress';
import { ArrowLeft, ArrowRight, LoaderCircle, Plus, Sparkles } from 'lucide-react';
import { ApiError, type Answer, type Api, type Range, dateTime, errorMessage } from '../../api';
import {useInsightHistory} from './useInsightHistory';
import { InsightReport } from './InsightReport';
import { answerPreview } from '../../AnswerMarkdown';
import { useHashChoice } from '../../useHashChoice';
import {rememberOriginalReturn,originalReferenceRoute} from '../../ask-original-reference';
type DiscoveryDraft={prompt:string;allTime:boolean;modelProfileId:string};
const drafts=new WeakMap<Api,DiscoveryDraft>();
const pendingAdmissions=new WeakMap<Api,{id:string;body:string}>();
const emptyDraft=():DiscoveryDraft=>({prompt:'',allTime:false,modelProfileId:''});
const readInsight = (hash: string) => new URLSearchParams(hash.split('?')[1] ?? '').get('insight');
export function Insights({ api, range, configured, onOpen, onSettings, onChanged, refreshVersion = 0 }: {
    refreshVersion?: number;
    api: Api;
    range: Range;
    configured: boolean;
    onOpen: (id: string) => void;
    onSettings: () => void;
    onChanged: () => void;
}) {
    const [composition,setComposition]=useState(()=>({api,...(drafts.get(api)??emptyDraft())}));
    const draft=composition.api===api?composition:drafts.get(api)??emptyDraft();
    const {prompt,allTime,modelProfileId}=draft;
    const updateDraft=(patch:Partial<DiscoveryDraft>)=>{const next={...draft,...patch};drafts.set(api,next);setComposition({api,...next});};
    const setPrompt=(prompt:string)=>updateDraft({prompt}),setAllTime=(allTime:boolean)=>updateDraft({allTime}),setModelProfileId=(modelProfileId:string)=>updateDraft({modelProfileId});
    const historyPosition=useRef(0),[controlsTarget,setControlsTarget]=useState<HTMLDivElement|null>(null);
    const choose=(id:string)=>{if(!selection)historyPosition.current=window.scrollY;chooseInsight(id);window.requestAnimationFrame(()=>window.scrollTo(0,0));};
    const historyBack=()=>{chooseInsight(null);window.requestAnimationFrame(()=>window.scrollTo(0,historyPosition.current));};
    const [selection, chooseInsight] = useHashChoice('insight', readInsight);
    const currentSelection = useRef(selection);
    currentSelection.current = selection;
    const creating = selection === 'new',unconfirmed=pendingAdmissions.has(api);
    const [automaticOwner,setAutomaticOwner]=useState<Api|null>(null);
    const [launching, setLaunching] = useState(false), [error, setError] = useState('');
    const history = useInsightHistory(api,refreshVersion), runHistory = useResource<{
        items: InsightRun[];
    }>(api, '/api/insight-runs', undefined, refreshVersion), abilities = useResource<{
        items: {
            id: string;
            name: string;
            description: string;
            version: string;
        }[];
    }>(api, '/api/skills');
    const feedError = useOperationUpdates(api), items = history.items, skills = abilities.data?.items ?? [], loading = history.loading && history.data === undefined;
    const answerId=creating?undefined:selection||undefined;
    // Original deletion need not create an execution event. Revalidate only the
    // selected report while visible; the shared resource stops when unmounted.
    const report=useResource<Answer>(api,answerId?'/api/insights/'+encodeURIComponent(answerId):null,5000,refreshVersion);
    const selectedRun=useResource<InsightRun>(api,answerId&&report.error instanceof ApiError&&[404,410].includes(report.error.status)?'/api/insight-runs/'+encodeURIComponent(answerId):null,undefined,refreshVersion);
    const reportLoading=Boolean(answerId&&report.loading&&report.data===undefined);
    const denied=history.accessDenied||report.error instanceof ApiError&&[401,403].includes(report.error.status);
    const visibleItems=denied?[]:items;
    useEffect(()=>{if(report.error instanceof ApiError&&[401,403,404,410].includes(report.error.status))history.refresh();},[api,report.error]);
    const [cancelling, setCancelling] = useState(false), cancelRequest = useRef<AbortController | null>(null);
    const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
    useEffect(() => {
        if (typeof document === 'undefined')
            return;
        const change = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', change);
        return () => document.removeEventListener('visibilitychange', change);
    }, []);
    const [run, setRun] = useState<InsightRun | null>(null), [pollError, setPollError] = useState(''), [reconnect, setReconnect] = useState(0), [now, setNow] = useState(Date.now());
    const busy = launching || run?.status === 'running', launchGuard = useRef(false), pendingRequest = useRef<{
        id: string;
        body: string;
    } | null>(null), changed = useRef(onChanged);
    const runs = run ? [run, ...(runHistory.data?.items ?? []).filter(item => item.id !== run.id)] : runHistory.data?.items ?? [];
    const restored = useRef(false), completedRuns = useRef(new Set<string>()), admission = useRef<AbortController | null>(null);
    changed.current = onChanged;
    useEffect(() => { cancelRequest.current?.abort(); cancelRequest.current = null; setCancelling(false); restored.current = false; completedRuns.current.clear(); setRun(null); setError(''); setPollError(''); setLaunching(false); launchGuard.current = false; pendingRequest.current = pendingAdmissions.get(api)??null; return () => { admission.current?.abort(); cancelRequest.current?.abort(); }; }, [api]);
    useEffect(() => {
        if(selection&&selection!=='new'){
            const exact=report.error instanceof ApiError&&[401,403].includes(report.error.status)||selectedRun.error!==undefined?undefined:selectedRun.data?.id===selection?selectedRun.data:runHistory.error===undefined?runHistory.data?.items.find(item=>item.id===selection):undefined;
            setRun(current=>current?.id===selection&&current.status!=='running'&&exact?.status==='running'?current:exact??null);
            return;
        }
        if (!restored.current && runHistory.data&&runHistory.error===undefined) {
            restored.current = true;
            setRun(current => current ?? (pendingAdmissions.has(api)?runHistory.data!.items.find(item=>item.id===pendingAdmissions.get(api)!.id):runHistory.data!.items.find(item => item.status === 'running')) ?? null);
        }
    }, [api,selection,report.error,runHistory.data,runHistory.error,selectedRun.data,selectedRun.error]);
    useEffect(() => { if (run)
        document.querySelector('.insight-progress')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [run?.id]);
    useEffect(() => { if (!busy)
        return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [busy]);
    useEffect(() => {
        if (!run || !visible || run.status === 'completed' && completedRuns.current.has(run.id))
            return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const next = await readResource<InsightRun>(api, `/api/insight-runs/${run.id}`, controller.signal);
                if (controller.signal.aborted)
                    return;
                setRun(current => current?.id === next.id && current.status !== 'running' && next.status === 'running' ? current : next);
                setPollError('');
                if(next.id===pendingAdmissions.get(api)?.id){pendingAdmissions.delete(api);pendingRequest.current=null;}
                if (next.status === 'completed')
                    completedRuns.current.add(next.id);
                if (next.status === 'completed' && next.result) {
                    const answer = next.result;
                    resources(api).invalidate(key => key.startsWith('/api/insights') || key === '/api/insight-runs');
                    if (currentSelection.current === 'new'||currentSelection.current===next.id) chooseInsight(answer.runId);
                    pendingRequest.current = null;
                    changed.current();
                }
                else if (next.status === 'completed') {
                    setError(moteText("这份报告已因原始资料变化而失效，请重新生成回顾。"));
                }
                if (next.status === 'running')
                    timer = setTimeout(poll, 1200);
            }
            catch (e) {
                if (!controller.signal.aborted) {
                    setPollError(errorMessage(e));
                    timer = setTimeout(poll, 3000);
                }
            }
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [api, run?.id, run?.status, reconnect, visible]);
    async function cancel() {
        if (!run || run.status !== 'running' || cancelRequest.current)
            return;
        const id = run.id, controller = new AbortController();
        cancelRequest.current = controller;
        setCancelling(true);
        setError('');
        try {
            const next = await api.request<InsightRun>(`/api/insight-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal: controller.signal });
            if (controller.signal.aborted)
                return;
            setRun(current => current?.id === id ? next : current);
            resources(api).invalidate(key => key.startsWith('/api/insights') || key === '/api/insight-runs');
        }
        catch (e) {
            if (!controller.signal.aborted)
                setError(errorMessage(e));
        }
        finally {
            if (cancelRequest.current === controller) {
                cancelRequest.current = null;
                if (!controller.signal.aborted)
                    setCancelling(false);
            }
        }
    }
    async function generate() {
        if (launchGuard.current || busy)
            return;
        restored.current = true;
        launchGuard.current = true;
        const controller = new AbortController();
        admission.current = controller;
        setLaunching(true);
        setError('');
        setPollError('');
        const body = pendingAdmissions.get(api)?.body??JSON.stringify({ ...(!allTime ? range : {}), modelProfileId: modelProfileId || undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, prompt: prompt.trim() || undefined });
        // Reuse the same id after an uncertain transport outcome, so retrying cannot launch twice.
        if (!pendingAdmissions.has(api)&&run && run.status !== 'running')
            pendingRequest.current = null;
        if (pendingRequest.current?.body !== body)
            pendingRequest.current = { id: crypto.randomUUID(), body };
        const request = pendingRequest.current!;
        pendingAdmissions.set(api,request);
        try {
            const next = await api.request<InsightRun>('/api/insight-runs', { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...JSON.parse(body), requestId: request.id }) });
            if (controller.signal.aborted)
                return;
            if(next.id!==request.id||!['running','completed','failed','cancelled'].includes(next.status))throw Error('Invalid insight admission receipt');
            pendingAdmissions.delete(api);pendingRequest.current=null;
            setRun(next);
            resources(api).invalidate(key => key === '/api/insight-runs');
            chooseInsight('new');
            setNow(Date.now());
        }
        catch (e) {
            if (!controller.signal.aborted) {
                if(e instanceof ApiError&&[400,401,403,404,409,410,422].includes(e.status)){pendingAdmissions.delete(api);pendingRequest.current=null;}else pendingAdmissions.set(api,request);
                setError(errorMessage(e));
                runHistory.refresh();
            }
        }
        finally {
            if (!controller.signal.aborted) {
                setLaunching(false);
                launchGuard.current = false;
            }
        }
    }
    const answer = !denied&&report.data?.runId===answerId?report.data:undefined;
    const viewingRun=!!selection&&selection!=='new'&&run?.id===selection;
    const visibleReportError=viewingRun?undefined:report.error;
    const missingReport=report.error instanceof ApiError&&[404,410].includes(report.error.status);
    return <section className={'insights-page final-insights '+(creating?'discovery-composing':selection?'discovery-reading':'discovery-history')} aria-busy={loading||reportLoading||(abilities.loading&&abilities.data===undefined)||(runHistory.loading&&runHistory.data===undefined)}>
    <div className="discovery-navigation">{selection?<button className="text-button discovery-back" onClick={historyBack}><ArrowLeft size={14}/>{moteText('发现历史')}</button>:<a className="text-button discovery-back" href="#/today"><ArrowLeft size={14}/>{moteText('首页')}</a>}{!selection&&<button className="button" disabled={launching} onClick={()=>{restored.current=true;choose('new');setError('');if(!pendingAdmissions.has(api)&&run?.status!=='running'){setRun(null);pendingRequest.current=null;}}}><Plus size={15}/>{moteText('生成回顾')}</button>}<div className="discovery-reading-tools" ref={setControlsTarget}/></div>
    {!selection&&<div className="page-heading"><h1>{moteText('发现历史')}</h1></div>}
    {creating&&<div className="page-heading"><h1>{moteText('生成回顾')}</h1><button className="text-button" onClick={()=>setAutomaticOwner(api)}>{moteText('自动生成设置')}</button></div>}
    {Boolean(error || history.error || history.moreError || visibleReportError || selectedRun.error || runHistory.error || abilities.error || feedError) && <div className="error-banner" role="alert">{error || errorMessage(history.error || history.moreError || visibleReportError || selectedRun.error || runHistory.error || abilities.error || feedError)}{Boolean(history.error||history.moreError)&&<button className="text-button" onClick={history.refresh}>{moteText("重新读取")}</button>}{Boolean(report.error)&&!missingReport&&<button className="text-button" onClick={report.refresh}>{moteText("重新读取")}</button>}</div>}
    <div className="workspace-layout"><aside className="workspace-list" aria-label={moteText("发现历史")}><div className="workspace-list-heading"><h2>{moteText("发现历史")}</h2><span>{visibleItems.length}</span></div>{loading && <p className="muted">{moteText("正在读取…")}</p>}{!loading && !history.error && !denied && !visibleItems.length && <p className="muted">{moteText("第一份发现会保存在这里，之后可以随时回看。")}</p>}{runs.filter(item => item.status !== 'completed').map(item => <button className="workspace-select" key={item.id} disabled={busy && item.id !== run?.id} onClick={() => { setRun(item); choose('new'); setReconnect(n => n + 1); }}><strong>{item.status === 'running' ? moteText("正在回顾…") : item.status === 'cancelled' ? moteText("回顾已取消") : moteText("回顾未完成")}</strong><small>{dateTime(item.createdAt)}</small>{item.error && <span>{failureMessage(item.execution?.failure ?? item.error)}</span>}</button>)}{visibleItems.map(item => <button className={'workspace-select ' + (!creating && answer?.runId === item.runId ? 'active' : '')} key={item.id || item.runId} onClick={() => { choose(item.runId); }}><strong>{item.artifact?.title || moteText("个人回顾")}</strong><span className="insight-excerpt">{answerPreview(item, 80)}</span><small>{item.createdAt ? dateTime(item.createdAt) : moteText("刚刚")} · {item.citations.length}{' '}{moteText("条证据")}</small></button>)}{history.nextCursor&&!denied&&<button className="button subtle" disabled={history.moreLoading} onClick={()=>void history.more()}>{moteText(history.moreLoading?"正在读取…":"加载更多")}</button>}</aside>
      <div className="workspace-content">{(creating||viewingRun)&&run && <InsightProgress cancelling={cancelling} onCancel={() => void cancel()} run={run} pollError={pollError} elapsed={Math.max(0, Math.floor(((run.status === 'running' ? now : Date.parse(run.updatedAt)) - Date.parse(run.createdAt)) / 1000))} onRetry={() => { setRun(null); pendingRequest.current = null; chooseInsight('new'); setError(''); }} onResume={() => setReconnect(n => n + 1)}/>} {creating ? run?<></>:<form className="panel insight-compose" onSubmit={e => { e.preventDefault(); void generate(); }}>{unconfirmed&&!launching&&<p className="notice" role="status">{moteText("上次提交结果尚未确认；先重试原要求，当前草稿会保留。")}</p>}<div className="compose-mark"><Sparkles size={26}/></div><h2>{moteText("你想从这些记录中看见什么？")}</h2><p className="muted">{moteText("可以给一个方向，也可以直接生成这段时间的个人回顾。")}</p><label className="field-label">{moteText("关注的方向")}{' '}<span className="muted">{moteText("选填")}</span><textarea disabled={busy} rows={5} maxLength={8000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={moteText("例如：回看我最近的项目推进，找出反复出现的阻碍，并列出值得跟进的线索。")}/></label><label className="field-label">{moteText("资料范围")}<select disabled={busy} value={allTime ? 'all' : 'selected'} onChange={e => setAllTime(e.target.value === 'all')}><option value="selected">{moteText("页面上方选择的时间范围")}</option><option value="all">{moteText("全部已归档资料")}</option></select><small>{allTime ? moteText("使用中央归档中的所有可检索资料。") : range.after ? moteText("从 {0}{1}", dateTime(range.after), range.before ? moteText(" 至 ") + dateTime(range.before) : moteText(" 至现在")) : moteText("当前没有时间限制。")}</small></label>
      <ModelSelector api={api} feature="insight" value={modelProfileId} onChange={setModelProfileId} disabled={busy}/>
      {!configured && <div className="review-notes"><strong>{moteText("先为 Mote 配置模型")}</strong><p>{moteText("资料会保留在归档中。完成配置后，即可生成洞察。")}</p><button type="button" className="button" onClick={onSettings}>{moteText("打开模型设置")}</button></div>}
      <div className="form-footer"><span className="muted">{moteText("结论附带引用，原始资料随时可查。")}</span><button className="button primary" disabled={busy || !configured}>{busy ? <LoaderCircle size={16} className="spin"/> : <ArrowRight size={16}/>} {launching ? moteText("正在启动…") : unconfirmed?moteText("重试"):busy ? moteText("回顾正在运行…") : moteText("生成个人回顾")}</button></div>{launching && <p role="status" className="muted">{moteText("正在向中央节点提交回顾任务…")}</p>}
      {skills.length > 0 && <details className="run-details"><summary>{moteText("Mote 可用的分析能力")}</summary><p>{moteText("按你选择的资料范围回顾经历，梳理项目进展、反复出现的线索与待核对的问题。结论附带原文引用，你可以继续提问或回到证据核对。")}</p><p>{moteText("填写「关注的方向」说明你想看什么；生成结果以实际读取的资料为依据。")}</p><details><summary>{moteText("高级：当前注册的分析能力")}</summary><div className="discovery-bounded-list" role="region" aria-label={moteText("分析能力技术详情")} tabIndex={0}>{skills.map(skill => <div key={skill.id}><strong>{skill.name}</strong><p>{skill.description}</p><code>{skill.id} · {skill.version}</code></div>)}</div></details></details>}
      </form> : viewingRun&&run?.status!=='completed'?null:answer ? <InsightReport key={answer.runId} owner={api} answer={answer} onOpen={onOpen} controlsTarget={controlsTarget} onAutomaticSettings={()=>setAutomaticOwner(api)} onAsk={()=>{rememberOriginalReturn(api,'insight',answer.runId);window.location.hash=originalReferenceRoute('insight',answer.runId);}}/> : <div className="panel workspace-empty"><Sparkles size={30}/><h2>{moteText(loading||reportLoading ? "正在读取…" : report.error&&!missingReport ? "报告暂不可读取，请重试。" : selection ? "这份发现当前不可用，请从历史选择其他发现。" : "选择一份发现，回到当时的线索。")}</h2></div>}</div>
    </div>
    {automaticOwner===api&&<InsightAutomaticSettings api={api} onClose={()=>setAutomaticOwner(null)} onSaved={onChanged}/>}
  </section>;
}
