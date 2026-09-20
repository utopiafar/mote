import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import type {Page} from './navigation';

import type {ProcessingJobView as Job,ProcessingView as View} from '@mote/shared';
const states:Record<string,string> = {waiting:'等待处理',running:'运行中',blocked:'受阻',failed:'失败',cancelled:'已取消',succeeded:'完成',stale:'来源变化待重验'};
const reasons:Record<string,string> = {dependency_failed:'依赖步骤未完成，请先检查上游任务',processor_version_unavailable:'处理器版本不可用',daily_budget:'等待每日额度',budget:'等待每日额度',cancelled:'用户取消',lease_expired:'运行中断，等待恢复'};
export function Processing({api,extensions=false,onNavigate}:{api:Api;extensions?:boolean;onNavigate:(page:Page)=>void}) {
  const [view,setView]=useState<View>(),[error,setError]=useState(''),[revision,setRevision]=useState(0),[busy,setBusy]=useState(''),[filter,setFilter]=useState('all');
  useEffect(()=>{const c=new AbortController();setError('');void api.request<View>('/api/processing',{signal:c.signal}).then(setView).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();},[api,revision]);
  async function act(job:Job,action:Job['allowedActions'][number]) {
    if(!job.allowedActions.includes(action)||busy)return;
    if(action==='cancel'&&!window.confirm(moteText('取消这个处理任务？已完成的产物会保留。')))return;
    setBusy(job.id);setError('');
    try {await api.request(`/api/processing/${encodeURIComponent(job.id)}/${action==='retry-step'?'retry':'cancel'}`,{method:'POST'});setRevision(n=>n+1);} catch(e){setError(errorMessage(e));} finally{setBusy('');}
  }
  return <><div className="page-heading"><div className="eyebrow">MOTE / SYSTEM</div><h1>{moteText(extensions?'扩展能力':'处理任务')}</h1><p>{moteText(extensions?'已注册的处理器及其版本。扩展由节点管理，不提供在线安装。':'查看处理步骤、依赖与等待原因。重试保留其他已完成步骤。')}</p></div>
    <div className="processing-actions"><button className="button" onClick={()=>setRevision(n=>n+1)}>{moteText('刷新')}</button><button className="button" onClick={()=>onNavigate('settings')}>{moteText('模型与服务')}</button></div>
    {error&&<p className="notice error" role="alert">{error}</p>}{!view&&!error&&<p role="status">{moteText('正在读取…')}</p>}
    {view&&extensions&&<div className="processing-list">{view.processors.map(p=><article className="processing-row" key={p.id}><h2>{p.id}</h2><p>{moteText('版本')} {p.version} · {p.lane}</p></article>)}</div>}
    {view&&!extensions&&<><nav className="section-tabs" aria-label={moteText('任务状态')}>{['all','waiting','running','blocked','failed','succeeded','cancelled','stale'].map(state=><button key={state} aria-current={filter===state?'page':undefined} onClick={()=>setFilter(state)}>{state==='all'?moteText('全部'):moteText(states[state])}</button>)}</nav>
      <div className="processing-list">{view.jobs.filter(j=>filter==='all'||j.state===filter).map(job=><article className="processing-row" key={job.id}><header><h2>{job.title}</h2><span className={'badge '+(['failed','blocked','stale'].includes(job.state)?'amber':job.state==='succeeded'?'green':'muted')}>{moteText(states[job.state]||job.state)}</span></header><p>{job.lane} · {moteText('尝试次数')} {job.attempts}</p>{job.reason&&<p>{moteText(reasons[job.reason]||job.reason)}</p>}{job.state==='waiting'&&job.availableAt>Date.now()&&<p>{moteText('下次可运行时间')} · {new Date(job.availableAt).toLocaleString()}</p>}<details><summary>{moteText('步骤详情')}</summary><p><code>{job.id}</code></p><p>{moteText('依赖步骤')} · {job.dependencies.length}</p>{job.dependencies.map(id=><p key={id}><code>{id}</code></p>)}<p>{moteText('已生成产物')} · {job.outputs.length}</p></details><div className="processing-actions">{job.allowedActions.map(action=><button className="button" key={action} disabled={!!busy} onClick={()=>void act(job,action)}>{moteText(action==='retry-step'?'重试此步骤':'取消')}</button>)}</div></article>)}</div>
      {!view.jobs.some(j=>filter==='all'||j.state===filter)&&<div className="empty"><h2>{moteText('没有符合条件的任务')}</h2></div>}<p className="fine-print">{moteText('显示最近 {0} 个上下文任务。文件、导入、记忆和问答保留各自的进度与操作。',view.limit)}</p>
      <div className="processing-actions">{(['files','imports','memories','ask','actions'] as const).map((page,i)=><button className="button" key={page} onClick={()=>onNavigate(page)}>{moteText(['文件与录音','导入','记忆','问一问','行动'][i])}</button>)}</div></>}
  </>;
}
