import {useEffect, useState} from 'react';
import {ArrowDownToLine, RefreshCw} from 'lucide-react';
import {type Api, bytes, duration, dateTime, errorMessage} from './api';

interface Snapshot {
  enabled:boolean;level:string;instanceId:string;lastSeq:number;retainedEvents:number;
  droppedEvents:number;writeFailures:number;readFailures:number;
  limits:{maxFileBytes:number;maxFiles:number;maxEvents:number};
  runtime:{uptimeMs:number;rssBytes:number;cpuUserMicros:number;cpuSystemMicros:number};
  services:{agentConfigured:boolean;embeddingConfigured:boolean;activeQueries:number};
  queue:{index:{pending:number;failed:number;indexed:number;textReady:number};devices:number;reportedPending:number};
}
interface Event {
  seq:number;at:string;event:string;level:string;requestId?:string;operation?:string;
  route?:string;category?:string;durationMs?:number;statusCode?:number;count?:number;
}

export function Diagnostics({api,profile}:{api:Api;profile?:string}) {
  const [snapshot,setSnapshot]=useState<Snapshot>();
  const [events,setEvents]=useState<Event[]>([]);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [error,setError]=useState('');
  const [filter,setFilter]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    setBusy(true);setError('');
    void (async()=>{
      const value=await api.request<Snapshot>('/api/diagnostics',{signal:controller.signal});
      const recent=await api.request<{items:Event[]}>(`/api/diagnostics/events?afterSeq=${Math.max(0,value.lastSeq-200)}&limit=200`,{signal:controller.signal});
      if(active){setSnapshot(value);setEvents(recent.items);}
    })().catch(e=>{if(active)setError(errorMessage(e));}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;controller.abort();};
  },[api,revision]);
  async function download() {
    setExporting(true);setError('');
    try{
      const response=await api.raw('/api/support-bundle');
      const url=URL.createObjectURL(await response.blob());
      const anchor=document.createElement('a');anchor.href=url;anchor.download=`mote-support-${new Date().toISOString().slice(0,10)}.json`;anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(errorMessage(e));}finally{setExporting(false);}
  }
  const visible=events.filter(event=>!filter.trim()||event.requestId?.includes(filter.trim())).slice().reverse();
  return <section className="panel diagnostics-panel" aria-labelledby="diagnostics-title">
    <div className="section-heading"><div><h2 id="diagnostics-title">运行诊断</h2><p>环境 · {profile||'legacy'} · 中央节点</p></div>
      <div className="diagnostics-actions">
        <button className="button subtle" onClick={()=>setRevision(n=>n+1)} disabled={busy}><RefreshCw size={15} className={busy?'spin':''}/>刷新诊断</button>
        <button className="button subtle" onClick={()=>void download()} disabled={exporting}><ArrowDownToLine size={15}/>{exporting?'正在导出…':'导出诊断包'}</button>
      </div>
    </div>
    <p className="fine-print">诊断包包含运行状态、数量、耗时和最近事件，不包含笔记、截图、模型对话或访问令牌。客户端的采集、电量和本地队列诊断从各自 App 导出。</p>
    {error&&<div className="notice error" role="alert">{error}</div>}
    {snapshot&&<>
      <div className="diagnostics-metrics">
        <div><strong>{duration(snapshot.runtime.uptimeMs)}</strong><span>本次运行</span></div>
        <div><strong>{bytes(snapshot.runtime.rssBytes)}</strong><span>进程内存</span></div>
        <div><strong>{snapshot.queue.reportedPending}</strong><span>端点上次上报待同步</span></div>
        <div><strong>{snapshot.queue.index.pending} / {snapshot.queue.index.failed}</strong><span>索引待处理 / 失败</span></div>
        <div><strong>{snapshot.services.activeQueries}</strong><span>进行中的 AI 查询</span></div>
      </div>
      <p className="fine-print">日志 {snapshot.enabled?snapshot.level:'已关闭'} · 最多 {snapshot.limits.maxFiles} 个文件，每个 {bytes(snapshot.limits.maxFileBytes)} · 内存保留 {snapshot.retainedEvents} 条事件。端点队列来自最近心跳，可能不是当前值。</p>
      {(snapshot.writeFailures>0||snapshot.readFailures>0||snapshot.droppedEvents>0)&&<div className="notice" role="status">日志读取失败 {snapshot.readFailures} 次，写入失败 {snapshot.writeFailures} 次，未写入 {snapshot.droppedEvents} 条。请检查日志目录权限与磁盘空间。</div>}
      <details className="diagnostics-events"><summary>最近运行事件 · {events.length} 条</summary>
        <label className="diagnostics-filter">按请求编号定位<input aria-label="诊断请求编号" placeholder="粘贴错误提示中的请求编号" value={filter} onChange={e=>setFilter(e.target.value)} maxLength={36}/></label>
        <div className="diagnostics-table-scroll"><table><thead><tr><th>时间</th><th>事件 / 阶段</th><th>结果</th><th>耗时</th><th>请求编号</th></tr></thead>
          <tbody>{visible.map(event=><tr key={event.seq}><td>{dateTime(event.at)}</td><td><code>{event.event}</code><small>{event.operation||event.route}</small></td><td>{event.category||event.statusCode||event.level}</td><td>{event.durationMs===undefined?'—':`${Math.round(event.durationMs)} ms`}</td><td><code className="diagnostic-request-id">{event.requestId||'—'}</code></td></tr>)}</tbody></table></div>
        {!visible.length&&<p className="fine-print">{filter?'最近事件中没有这个请求编号；较早的事件可在节点日志中定位。':snapshot.enabled?'暂时没有运行事件。':'运行日志已关闭，可在中央节点配置中开启。'}</p>}
      </details>
    </>}
  </section>;
}
