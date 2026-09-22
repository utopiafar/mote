import {useResource} from './useResource';
import {useOperationUpdates} from './useOperationUpdates';
import {readResource,resources} from './resource-cache';
import {failureMessage} from './failure-message';
import { moteText } from '@mote/shared/i18n';
import {ModelSelector} from './ModelSelector';
import {useEffect,useRef,useState} from 'react';
import {InsightProgress,type InsightRun} from './InsightProgress';
import {ArrowRight,LoaderCircle,Plus,Sparkles} from 'lucide-react';
import {type Answer,type Api,type Range,dateTime,errorMessage} from './api';
import {InsightReport} from './InsightReport';
import {answerPreview} from './AnswerMarkdown';

export function Insights({api,range,configured,onOpen,onSettings,onChanged,refreshVersion=0}:{refreshVersion?:number;api:Api;range:Range;configured:boolean;onOpen:(id:string)=>void;onSettings:()=>void;onChanged:()=>void}){
  const [modelProfileId,setModelProfileId]=useState('');
  const [selected,setSelected]=useState(''),[creating,setCreating]=useState(true);
  const [prompt,setPrompt]=useState(''),[allTime,setAllTime]=useState(false),[launching,setLaunching]=useState(false),[error,setError]=useState('');
  const history=useResource<{items:Answer[]}>(api,'/api/insights'),runHistory=useResource<{items:InsightRun[]}>(api,'/api/insight-runs'),abilities=useResource<{items:{id:string;name:string;description:string;version:string}[]}>(api,'/api/skills');
  const feedError=useOperationUpdates(api),items=history.data?.items??[],skills=abilities.data?.items??[],loading=history.loading;
  const [run,setRun]=useState<InsightRun|null>(null),[pollError,setPollError]=useState(''),[reconnect,setReconnect]=useState(0),[now,setNow]=useState(Date.now());
  const busy=launching||run?.status==='running', launchGuard=useRef(false),pendingRequest=useRef<{id:string;body:string}|null>(null),changed=useRef(onChanged);
  const runs=run?[run,...(runHistory.data?.items??[]).filter(item=>item.id!==run.id)]:runHistory.data?.items??[];
  const restored=useRef(false),admission=useRef<AbortController|null>(null);
  changed.current=onChanged;
  useEffect(()=>{restored.current=false;setRun(null);setSelected('');setCreating(true);setError('');setPollError('');setLaunching(false);launchGuard.current=false;pendingRequest.current=null;return()=>admission.current?.abort();},[api]);
  useEffect(()=>{if(!restored.current&&runHistory.data){restored.current=true;setRun(current=>current??runHistory.data!.items.find(item=>item.status==='running')??null);}},[runHistory.data]);
  useEffect(()=>{if(refreshVersion)resources(api).invalidate(key=>key==='/api/insights'||key==='/api/insight-runs');},[api,refreshVersion]);
  useEffect(()=>{if(run)document.querySelector('.insight-progress')?.scrollIntoView({block:'start',behavior:'smooth'});},[run?.id]);
  useEffect(()=>{if(!busy)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[busy]);
  useEffect(()=>{
    if(!run)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{
        const next=await readResource<InsightRun>(api,`/api/insight-runs/${run.id}`,controller.signal);
        if(controller.signal.aborted)return;setRun(next);setPollError('');
        if(next.status==='completed'&&next.result){const answer=next.result;resources(api).invalidate(key=>key==='/api/insights'||key==='/api/insight-runs');setSelected(answer.runId);setCreating(false);pendingRequest.current=null;changed.current();}
        else if(next.status==='completed'){setError(moteText("这份报告已因原始资料变化而失效，请重新生成回顾。"));}
        if(next.status==='running')timer=setTimeout(poll,1200);
      }catch(e){if(!controller.signal.aborted){setPollError(errorMessage(e));timer=setTimeout(poll,3000);}}
    };
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[api,run?.id,reconnect]);
  async function generate(){
    if(launchGuard.current||busy)return;restored.current=true;launchGuard.current=true;const controller=new AbortController();admission.current=controller;setLaunching(true);setError('');setPollError('');
    const body=JSON.stringify({...(!allTime?range:{}),modelProfileId:modelProfileId||undefined,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,prompt:prompt.trim()||undefined});
    // Reuse the same id after an uncertain transport outcome, so retrying cannot launch twice.
    if(run?.status==='failed'||run?.status==='completed')pendingRequest.current=null;
    if(pendingRequest.current?.body!==body)pendingRequest.current={id:crypto.randomUUID(),body};
    const request=pendingRequest.current!;
    try{
      const next=await api.request<InsightRun>('/api/insight-runs',{method:'POST',signal:controller.signal,body:JSON.stringify({...JSON.parse(body),requestId:request.id})});
      if(controller.signal.aborted)return;setRun(next);resources(api).invalidate(key=>key==='/api/insight-runs');setCreating(true);setNow(Date.now());
    }catch(e){if(!controller.signal.aborted){setError(errorMessage(e));runHistory.refresh();}}finally{if(!controller.signal.aborted){setLaunching(false);launchGuard.current=false;}}
  }
  const answer=items.find(item=>item.runId===selected);
  return <section className="insights-page"><div className="page-heading split-heading"><div><div className="eyebrow">{moteText("从记录里发现值得回看的事")}</div><h1>{moteText("洞察")}</h1><p>{moteText("让 Mote 阅读你的资料，生成带有证据的回顾与分析。")}</p></div><button className="button primary" disabled={busy} onClick={()=>{restored.current=true;setCreating(true);setSelected('');setError('');setRun(null);pendingRequest.current=null;}}><Plus size={16}/>{moteText("新建洞察")}</button></div>
    {Boolean(error||history.error||runHistory.error||abilities.error||feedError)&&<div className="error-banner" role="alert">{error||errorMessage(history.error||runHistory.error||abilities.error||feedError)}</div>}
    <div className="workspace-layout"><aside className="workspace-list" aria-label={moteText("洞察历史")}><div className="workspace-list-heading"><h2>{moteText("过去的洞察")}</h2><span>{items.length}</span></div>{loading&&<p className="muted">{moteText("正在读取…")}</p>}{!loading&&!history.error&&!items.length&&<p className="muted">{moteText("第一份洞察会保存在这里，之后可以随时回看。")}</p>}{runs.filter(item=>item.status!=='completed').map(item=><button className="workspace-select" key={item.id} disabled={busy&&item.id!==run?.id} onClick={()=>{setRun(item);setCreating(true);setSelected('');setReconnect(n=>n+1);}}><strong>{item.status==='running'?moteText("正在回顾…"):moteText("回顾未完成")}</strong><small>{dateTime(item.createdAt)}</small>{item.error&&<span>{failureMessage(item.execution?.failure??item.error)}</span>}</button>)}{items.map(item=><button className={'workspace-select '+(!creating&&selected===item.runId?'active':'')} key={item.id||item.runId} onClick={()=>{setCreating(false);setSelected(item.runId);}}><strong>{item.artifact?.title||moteText("个人回顾")}</strong><span className="insight-excerpt">{answerPreview(item,80)}</span><small>{item.createdAt?dateTime(item.createdAt):moteText("刚刚")} · {item.citations.length}{' '}{moteText("条证据")}</small></button>)}</aside>
      <div className="workspace-content">{run&&<InsightProgress run={run} pollError={pollError} elapsed={Math.max(0,Math.floor(((run.status==='running'?now:Date.parse(run.updatedAt))-Date.parse(run.createdAt))/1000))} onRetry={()=>{setRun(null);pendingRequest.current=null;setCreating(true);setError('');}} onResume={()=>setReconnect(n=>n+1)}/>} {creating?<form className="panel insight-compose" onSubmit={e=>{e.preventDefault();void generate();}}><div className="compose-mark"><Sparkles size={26}/></div><h2>{moteText("你想从这些记录中看见什么？")}</h2><p className="muted">{moteText("可以给一个方向，也可以直接生成这段时间的个人回顾。")}</p><label className="field-label">{moteText("关注的方向")}{' '}<span className="muted">{moteText("选填")}</span><textarea disabled={busy} rows={5} maxLength={8000} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder={moteText("例如：回看我最近的项目推进，找出反复出现的阻碍，并列出值得跟进的线索。")}/></label><label className="field-label">{moteText("资料范围")}<select disabled={busy} value={allTime?'all':'selected'} onChange={e=>setAllTime(e.target.value==='all')}><option value="selected">{moteText("页面上方选择的时间范围")}</option><option value="all">{moteText("全部已归档资料")}</option></select><small>{allTime?moteText("使用中央归档中的所有可检索资料。"):range.after?moteText("从 {0}{1}", dateTime(range.after), range.before?moteText(" 至 ")+dateTime(range.before):moteText(" 至现在")):moteText("当前没有时间限制。")}</small></label>
      <ModelSelector api={api} feature="insight" value={modelProfileId} onChange={setModelProfileId} disabled={busy}/>
      {!configured&&<div className="review-notes"><strong>{moteText("先为 Mote 配置模型")}</strong><p>{moteText("资料会保留在归档中。完成配置后，即可生成洞察。")}</p><button type="button" className="button" onClick={onSettings}>{moteText("打开模型设置")}</button></div>}
      <div className="form-footer"><span className="muted">{moteText("结论附带引用，原始资料随时可查。")}</span><button className="button primary" disabled={busy||!configured}>{busy?<LoaderCircle size={16} className="spin"/>:<ArrowRight size={16}/>} {launching?moteText("正在启动…"):busy?moteText("回顾正在运行…"):moteText("生成个人回顾")}</button></div>{launching&&<p role="status" className="muted">{moteText("正在向中央节点提交回顾任务…")}</p>}
      {skills.length>0&&<details className="run-details"><summary>{moteText("Mote 可用的分析能力")}</summary>{skills.map(skill=><div key={skill.id}><strong>{skill.name}</strong><p>{skill.description}</p></div>)}</details>}
      </form>:answer?<InsightReport key={answer.runId} answer={answer} onOpen={onOpen}/>:<div className="panel workspace-empty"><Sparkles size={30}/><h2>{moteText("选择一份洞察，回到当时的线索。")}</h2></div>}</div>
    </div>
  </section>;
}
