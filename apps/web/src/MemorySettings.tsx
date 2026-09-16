import {useEffect,useState} from 'react';
import {type Api,errorMessage,dateTime} from './api';
type Policy={enabled:boolean;intervalHours:number;minChanges:number;maxItems:number};
type Settings={extraction:Policy;consolidation:Policy;insights:Policy;working:Policy;batchCharacters:number;recentTurns:number;contextCharacters:number;summaryCharacters:number};
type View={settings:Settings;extensions:{id:string;version:string;status:string;pendingChanges:number;dueAt:number;failures:number;cursor:number}[]};
const names={extraction:'资料记忆提取',consolidation:'长期记忆整理',insights:'周期洞察',working:'对话工作记忆'};
const statuses:Record<string,string>={disabled:'已关闭',pending:'处理中或等待重试',waiting_for_model:'等待配置模型',waiting_for_interval:'等待周期',waiting_for_increment:'等待新增变化',ready:'等待下一次检查'};
export function MemorySettings({api}:{api:Api}){
  const [view,setView]=useState<View>(),[draft,setDraft]=useState<Settings>(),[error,setError]=useState(''),[saved,setSaved]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{const controller=new AbortController();void api.request<View>('/api/memory-settings',{signal:controller.signal}).then(v=>{setView(v);setDraft(v.settings);}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});return()=>controller.abort();},[api]);
  async function save(){setBusy(true);setSaved(false);setError('');try{const v=await api.request<View>('/api/memory-settings',{method:'PUT',body:JSON.stringify(draft)});setView(v);setDraft(v.settings);setSaved(true);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  return <section className="panel memory-settings"><div className="section-heading"><div><h2>记忆与洞察的节奏</h2><p>周期已到，并且新增变化达到门槛时才运行。每分钟检查一次；保存后直接生效，进行中的一轮沿用启动时的设置。</p></div></div>
    {error&&<p className="notice error" role="alert">{error}</p>}{saved&&<p role="status">设置已保存。</p>}
    {draft&&<form onSubmit={e=>{e.preventDefault();void save();}}>
      {(Object.keys(names) as (keyof typeof names)[]).map(id=>{const p=draft[id],state=view?.extensions.find(e=>e.id===id);return <fieldset key={id} disabled={busy}><legend>{names[id]}</legend><label><input type="checkbox" checked={p.enabled} onChange={e=>{setSaved(false);setDraft({...draft,[id]:{...p,enabled:e.target.checked}});}}/>启用自动整理</label><div className="memory-settings-grid">{([['intervalHours','间隔（小时）',1/60,8760],['minChanges',id==='working'?'新增对话轮次':'新增变化数',1,100000],['maxItems','每轮最多处理变化',1,id==='consolidation'?50:2000]] as const).map(([key,label,min,max])=><label key={key}>{label}<input type="number" min={min} max={max} step={key==='intervalHours'?'any':1} required value={p[key]} onChange={e=>{setSaved(false);setDraft({...draft,[id]:{...p,[key]:Number(e.target.value)}});}}/></label>)}</div>{state&&<p className="muted">{statuses[state.status]??state.status} · 待处理 {state.pendingChanges} 次变化 · 周期到达时间 {dateTime(new Date(state.dueAt).toISOString())}{state.failures>0?` · 已失败 ${state.failures} 次，自动退避重试`:''}</p>}</fieldset>;})}
      <fieldset disabled={busy}><legend>每次披露的内容量</legend><div className="memory-settings-grid">{([['batchCharacters','提取批次字符上限',256,12000],['recentTurns','至少保留近期对话轮数',2,20],['contextCharacters','对话上下文字符上限',4000,60000],['summaryCharacters','工作记忆字符上限',1000,12000]] as const).map(([key,label,min,max])=><label key={key}>{label}<input type="number" min={min} max={max} step="1" required value={draft[key]} onChange={e=>{setSaved(false);setDraft({...draft,[key]:Number(e.target.value)});}}/></label>)}</div></fieldset>
      <p>记忆以文本保存，按“概览 → 内容与边界 → 原始证据”逐层展开，全文索引可从文本重建。自动生成的长期记忆需要你确认。高频上传建议保留较长周期和每轮上限。</p><button className="button primary" disabled={busy} type="submit">{busy?'正在保存…':'保存记忆设置'}</button>
    </form>}
  </section>;
}
