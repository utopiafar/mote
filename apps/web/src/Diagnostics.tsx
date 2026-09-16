import {useEffect, useRef, useState} from 'react';
import {ArrowDownToLine, RefreshCw} from 'lucide-react';
import {type Api, bytes, duration, errorMessage} from './api';

interface Snapshot {
  enabled:boolean;level:string;instanceId:string;lastSeq:number;retainedEvents:number;
  droppedEvents:number;writeFailures:number;readFailures:number;
  limits:{maxFileBytes:number;maxFiles:number;maxEvents:number};
  runtime:{uptimeMs:number;rssBytes:number;cpuUserMicros:number;cpuSystemMicros:number};
  services:{agentConfigured:boolean;embeddingConfigured:boolean;activeQueries:number};
  queue:{index:{pending:number;failed:number;indexed:number;textReady:number};devices:number;reportedPending:number};
}
export function Diagnostics({api,profile}:{api:Api;profile?:string}) {
  const [snapshot,setSnapshot]=useState<Snapshot>();
  const [rawLog,setRawLog]=useState('');
  const [wrap,setWrap]=useState(true);
  const [logFile,setLogFile]=useState(0);
  const [copyStatus,setCopyStatus]=useState('');
  const logRef=useRef<HTMLTextAreaElement>(null);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    setBusy(true);setError('');
    void (async()=>{
      const value=await api.request<Snapshot>('/api/diagnostics',{signal:controller.signal});
      const response=await api.raw(`/api/diagnostics/logs?file=${logFile}`,{signal:controller.signal});
      const raw=await response.text();
      if(active){setSnapshot(value);setRawLog(raw);setCopyStatus('');}
    })().catch(e=>{if(active)setError(errorMessage(e));}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;controller.abort();};
  },[api,revision,logFile]);
  async function download() {
    setExporting(true);setError('');
    try{
      const response=await api.raw('/api/support-bundle');
      const url=URL.createObjectURL(await response.blob());
      const anchor=document.createElement('a');anchor.href=url;anchor.download=`mote-support-${new Date().toISOString().slice(0,10)}.json`;anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(errorMessage(e));}finally{setExporting(false);}
  }
  async function copyLogs() {
    try {await navigator.clipboard.writeText(rawLog);setCopyStatus('已复制全部原始日志。');}
    catch {logRef.current?.focus();logRef.current?.select();setCopyStatus('剪贴板不可用，已全选，请按 ⌘/Ctrl+C 复制。');}
  }
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
      <section className="diagnostics-events" aria-labelledby="raw-log-title">
        <div className="section-heading"><div><h3 id="raw-log-title">日志中心</h3><p>原始顺序 · 刷新时更新</p></div>
          <div className="diagnostics-actions">
            <select aria-label="日志文件" value={logFile} disabled={busy} onChange={e=>{setRawLog('');setLogFile(Number(e.target.value));}}>
              {Array.from({length:snapshot.limits.maxFiles},(_,index)=><option key={index} value={index}>central.{index}.ndjson{index===0?' · 当前':' · 历史 '+index}</option>)}
            </select>
            <button className="button subtle" disabled={!rawLog} onClick={()=>void copyLogs()}>复制全部</button>
            <button className="button subtle" disabled={!rawLog} onClick={()=>{logRef.current?.focus();logRef.current?.select();}}>全选</button>
            <button className="button subtle" aria-pressed={wrap} onClick={()=>setWrap(v=>!v)}>自动换行</button>
          </div>
        </div>
        <p className="fine-print">直接显示所选日志文件，不拆字段或重排。可拖动选中，使用 ⌘/Ctrl+A、C 复制；历史编号越大，文件越早。</p>
        <textarea ref={logRef} className="raw-log-output" aria-label="原始日志" readOnly spellCheck={false} wrap={wrap?'soft':'off'} value={rawLog} placeholder={snapshot.enabled?'暂无日志。':'运行日志已关闭，历史仍可查看。'}/>
        <p className="fine-print" role="status">{copyStatus}</p>
      </section>
    </>}
  </section>;
}
