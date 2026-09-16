import {useEffect,useState} from 'react';
import {ArrowRight,LoaderCircle,Plus,Sparkles} from 'lucide-react';
import {type Answer,type Api,type Range,dateTime,errorMessage} from './api';
import {InsightReport} from './InsightReport';
import {answerPreview} from './AnswerMarkdown';

export function Insights({api,range,configured,onOpen,onSettings,onChanged,refreshVersion=0}:{refreshVersion?:number;api:Api;range:Range;configured:boolean;onOpen:(id:string)=>void;onSettings:()=>void;onChanged:()=>void}){
  const [items,setItems]=useState<Answer[]>([]),[selected,setSelected]=useState(''),[creating,setCreating]=useState(true);
  const [prompt,setPrompt]=useState(''),[allTime,setAllTime]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [skills,setSkills]=useState<{id:string;name:string;description:string;version:string}[]>([]);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    void api.request<{items:Answer[]}>('/api/insights',{signal:controller.signal}).then(result=>{if(!controller.signal.aborted){setItems(result.items);setLoading(false);}}).catch(e=>{if(!controller.signal.aborted){setError(errorMessage(e));setLoading(false);}});
    void api.request<{items:typeof skills}>('/api/skills',{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setSkills(result.items);}).catch(()=>{});
    return ()=>controller.abort();
  },[api,revision,refreshVersion]);
  async function generate(){
    setBusy(true);setError('');
    try{
      const answer=await api.request<Answer>('/api/insights',{method:'POST',body:JSON.stringify({...(!allTime?range:{}),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,prompt:prompt.trim()||undefined})});
      setItems(current=>[answer,...current.filter(item=>item.runId!==answer.runId)]);setSelected(answer.runId);setCreating(false);onChanged();setRevision(value=>value+1);
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  const answer=items.find(item=>item.runId===selected);
  return <section className="insights-page"><div className="page-heading split-heading"><div><div className="eyebrow">从记录里发现值得回看的事</div><h1>洞察</h1><p>让 Mote 阅读你的资料，生成带有证据的回顾与分析。</p></div><button className="button primary" disabled={busy} onClick={()=>{setCreating(true);setSelected('');setError('');}}><Plus size={16}/>新建洞察</button></div>
    {error&&<div className="error-banner" role="alert">{error}</div>}
    <div className="workspace-layout"><aside className="workspace-list" aria-label="洞察历史"><div className="workspace-list-heading"><h2>过去的洞察</h2><span>{items.length}</span></div>{loading&&<p className="muted">正在读取…</p>}{!loading&&!items.length&&<p className="muted">第一份洞察会保存在这里，之后可以随时回看。</p>}{items.map(item=><button className={'workspace-select '+(!creating&&selected===item.runId?'active':'')} key={item.id||item.runId} onClick={()=>{setCreating(false);setSelected(item.runId);}}><strong>{item.artifact?.title||'个人回顾'}</strong><span className="insight-excerpt">{answerPreview(item,80)}</span><small>{item.createdAt?dateTime(item.createdAt):'刚刚'} · {item.citations.length} 条证据</small></button>)}</aside>
      <div className="workspace-content">{creating?<form className="panel insight-compose" onSubmit={e=>{e.preventDefault();void generate();}}><div className="compose-mark"><Sparkles size={26}/></div><h2>你想从这些记录中看见什么？</h2><p className="muted">可以给一个方向，也可以直接生成这段时间的个人回顾。</p><label className="field-label">关注的方向 <span className="muted">选填</span><textarea rows={5} maxLength={8000} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="例如：回看我最近的项目推进，找出反复出现的阻碍，并列出值得跟进的线索。"/></label><label className="field-label">资料范围<select value={allTime?'all':'selected'} onChange={e=>setAllTime(e.target.value==='all')}><option value="selected">页面上方选择的时间范围</option><option value="all">全部已归档资料</option></select><small>{allTime?'使用中央归档中的所有可检索资料。':range.after?`从 ${dateTime(range.after)}${range.before?' 至 '+dateTime(range.before):' 至现在'}`:'当前没有时间限制。'}</small></label>
      {!configured&&<div className="review-notes"><strong>先为 Mote 配置模型</strong><p>资料会保留在归档中。完成配置后，即可生成洞察。</p><button type="button" className="button" onClick={onSettings}>打开模型设置</button></div>}
      <div className="form-footer"><span className="muted">结论附带引用，原始资料随时可查。</span><button className="button primary" disabled={busy||!configured}>{busy?<LoaderCircle size={16} className="spin"/>:<ArrowRight size={16}/>} {busy?'正在阅读资料并生成报告…':'生成洞察'}</button></div>{busy&&<p role="status" className="muted">生成可能需要几分钟，请保留此页面。</p>}
      {skills.length>0&&<details className="run-details"><summary>Mote 可用的分析能力</summary>{skills.map(skill=><div key={skill.id}><strong>{skill.name}</strong><p>{skill.description}</p></div>)}</details>}
      </form>:answer?<InsightReport key={answer.runId} answer={answer} onOpen={onOpen}/>:<div className="panel workspace-empty"><Sparkles size={30}/><h2>选择一份洞察，回到当时的线索。</h2></div>}</div>
    </div>
  </section>;
}
