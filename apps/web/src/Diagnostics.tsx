import { moteText } from '@mote/shared/i18n';
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
interface LogPage {
  items:string[];page:number;pageSize:number;totalLines:number;totalPages:number;
  hasPrevious:boolean;hasNext:boolean;
}
type LogStage='all'|'system'|'request'|'ingest'|'index'|'agent'|'source'|'maintenance'|'file'|'unknown';
const logStages:readonly [LogStage,string][]= [['all',moteText("全部阶段")],['system',moteText("系统")],['request',moteText("请求")],['ingest',moteText("入库")],['index',moteText("索引")],['agent','Agent'],['source',moteText("资料")],['maintenance',moteText("维护")],['file',moteText("文件")],['unknown',moteText("未知")]];
export function Diagnostics({api,profile}:{api:Api;profile?:string}) {
  const [snapshot,setSnapshot]=useState<Snapshot>();
  const [logPageData,setLogPageData]=useState<LogPage>();
  const [rawLog,setRawLog]=useState('');
  const [wrap,setWrap]=useState(true);
  const [logFile,setLogFile]=useState(0);
  const [logPage,setLogPage]=useState(1);
  const [pageSize,setPageSize]=useState(100);
  const [logStage,setLogStage]=useState<LogStage>('all');
  const [autoRefresh,setAutoRefresh]=useState(false);
  const [copyStatus,setCopyStatus]=useState('');
  const logRef=useRef<HTMLTextAreaElement>(null);
  const [revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [hours,setHours]=useState(24);
  const [error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    setBusy(true);setError('');
    void (async()=>{
      const value=await api.request<Snapshot>('/api/diagnostics',{signal:controller.signal});
      const page=await api.request<LogPage>(`/api/diagnostics/log-pages?file=${logFile}&page=${logPage}&pageSize=${pageSize}&stage=${logStage}`,{signal:controller.signal});
      if(active){setSnapshot(value);setLogPageData(page);setLogPage(page.page);setRawLog(page.items.length?page.items.join('\n')+'\n':'');setCopyStatus('');}
    })().catch(e=>{if(active)setError(errorMessage(e));}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;controller.abort();};
  },[api,revision,logFile,logPage,pageSize,logStage]);
  useEffect(()=>{
    if(!autoRefresh)return;
    const timer=window.setInterval(()=>setRevision(n=>n+1),5000);
    return()=>window.clearInterval(timer);
  },[autoRefresh]);
  async function download() {
    setExporting(true);setError('');
    try{
      const response=await api.raw('/api/support-bundle?after='+encodeURIComponent(new Date(Date.now()-hours*3600000).toISOString())+'&before='+encodeURIComponent(new Date().toISOString()));
      const url=URL.createObjectURL(await response.blob());
      const anchor=document.createElement('a');anchor.href=url;anchor.download=`mote-support-${new Date().toISOString().slice(0,10)}.json`;anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setError(errorMessage(e));}finally{setExporting(false);}
  }
  async function copyLogs() {
    try {await navigator.clipboard.writeText(rawLog);setCopyStatus(moteText("已复制当前页日志。"));}
    catch {logRef.current?.focus();logRef.current?.select();setCopyStatus(moteText("剪贴板不可用，已全选，请按 ⌘/Ctrl+C 复制。"));}
  }
  return <section className="panel diagnostics-panel" aria-labelledby="diagnostics-title">
    <div className="section-heading"><div><h2 id="diagnostics-title">{moteText("运行诊断")}</h2><p>{moteText("环境 ·")}{' '}{profile||'legacy'}{' '}{moteText("· 中央节点")}</p></div>
      <div className="diagnostics-actions">
        <button className="button subtle" onClick={()=>setRevision(n=>n+1)} disabled={busy}><RefreshCw size={15} className={busy?'spin':''}/>{moteText("刷新诊断")}</button>
        <select aria-label={moteText("导出时间范围")} value={hours} onChange={e=>setHours(Number(e.target.value))}><option value={1}>{moteText("最近 1 小时")}</option><option value={24}>{moteText("最近 24 小时")}</option><option value={168}>{moteText("最近 7 天")}</option></select><button className="button subtle" onClick={()=>void download()} disabled={exporting}><ArrowDownToLine size={15}/>{exporting?moteText("正在导出…"):moteText("导出诊断包")}</button>
      </div>
    </div>
    <p className="fine-print">{moteText("导出所选时段内全部已保留日志；日志轮转前已清理的部分无法恢复，导出包会注明覆盖范围。")}</p><p className="fine-print">{moteText("诊断包包含运行状态、数量、耗时和最近事件，不包含笔记、截图、模型对话或访问令牌。客户端的采集、电量和本地队列诊断从各自 App 导出。")}</p>
    {error&&<div className="notice error" role="alert">{error}</div>}
    {snapshot&&<>
      <div className="diagnostics-metrics">
        <div><strong>{duration(snapshot.runtime.uptimeMs)}</strong><span>{moteText("本次运行")}</span></div>
        <div><strong>{bytes(snapshot.runtime.rssBytes)}</strong><span>{moteText("进程内存")}</span></div>
        <div><strong>{snapshot.queue.reportedPending}</strong><span>{moteText("端点上次上报待同步")}</span></div>
        <div><strong>{snapshot.queue.index.pending} / {snapshot.queue.index.failed}</strong><span>{moteText("索引待处理 / 失败")}</span></div>
        <div><strong>{snapshot.services.activeQueries}</strong><span>{moteText("进行中的 AI 查询")}</span></div>
      </div>
      <p className="fine-print">{moteText("日志")}{' '}{snapshot.enabled?snapshot.level:moteText("已关闭")}{' '}{moteText("· 最多")}{' '}{snapshot.limits.maxFiles}{' '}{moteText("个文件，每个")}{' '}{bytes(snapshot.limits.maxFileBytes)}{' '}{moteText("· 内存保留")}{' '}{snapshot.retainedEvents}{' '}{moteText("条事件。端点队列来自最近心跳，可能不是当前值。")}</p>
      {(snapshot.writeFailures>0||snapshot.readFailures>0||snapshot.droppedEvents>0)&&<div className="notice" role="status">{moteText("日志读取失败")}{' '}{snapshot.readFailures}{' '}{moteText("次，写入失败")}{' '}{snapshot.writeFailures}{' '}{moteText("次，未写入")}{' '}{snapshot.droppedEvents}{' '}{moteText("条。请检查日志目录权限与磁盘空间。")}</div>}
      <section className="diagnostics-events" aria-labelledby="raw-log-title">
        <div className="section-heading"><div><h3 id="raw-log-title">{moteText("日志中心")}</h3><p>{moteText("原始顺序 · 刷新时更新")}</p></div>
          <div className="diagnostics-actions">
            <select aria-label={moteText("日志文件")} value={logFile} disabled={busy} onChange={e=>{setRawLog('');setLogFile(Number(e.target.value));}}>
              {Array.from({length:snapshot.limits.maxFiles},(_,index)=><option key={index} value={index}>central.{index}.ndjson{index===0?moteText(" · 当前"):moteText(" · 历史 ")+index}</option>)}
            </select>
            <button className="button subtle" disabled={!rawLog} onClick={()=>void copyLogs()}>{moteText("复制当前页")}</button>
            <button className="button subtle" disabled={!rawLog} onClick={()=>{logRef.current?.focus();logRef.current?.select();}}>{moteText("全选")}</button>
            <button className="button subtle" aria-pressed={wrap} onClick={()=>setWrap(v=>!v)}>{moteText("自动换行")}</button>
          </div>
        </div>
        <p className="fine-print">{moteText("默认从当前日志的最新一页开始；翻页查看更早内容，刷新时不会离开当前页。可按阶段筛选，日志仍按原始顺序显示，不拆字段或重排。")}</p>
        <div className="log-pagination" aria-label={moteText("日志分页")}>
          <div className="log-pagination-controls">
            <button className="button subtle" disabled={busy||logPage===1} onClick={()=>setLogPage(1)}>{moteText("最新")}</button>
            <button className="button subtle" disabled={busy||!logPageData?.hasNext} onClick={()=>setLogPage(page=>Math.max(1,page-1))}>{moteText("较新")}</button>
            <span className="log-page-summary" role="status">{moteText("第 {0} / {1} 页",logPage,logPageData?.totalPages??1)} · {moteText("共 {0} 条",logPageData?.totalLines??0)}</span>
            <button className="button subtle" disabled={busy||!logPageData?.hasPrevious} onClick={()=>setLogPage(page=>page+1)}>{moteText("较旧")}</button>
          </div>
          <div className="log-pagination-options">
            <label>{moteText("阶段")}{' '}<select aria-label={moteText("日志阶段")} value={logStage} disabled={busy} onChange={e=>{setLogPage(1);setLogStage(e.target.value as LogStage);}}>{logStages.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            <button className="button subtle" onClick={()=>setRevision(n=>n+1)} disabled={busy}><RefreshCw size={14} className={busy?'spin':''}/>{moteText("手动刷新")}</button>
            <label>{moteText("每页")}{' '}<select aria-label={moteText("每页条数")} value={pageSize} disabled={busy} onChange={e=>{setLogPage(1);setPageSize(Number(e.target.value));}}><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select></label>
            <label className="log-auto-refresh"><input type="checkbox" checked={autoRefresh} onChange={e=>setAutoRefresh(e.target.checked)}/>{moteText("自动刷新（5 秒）")}</label>
          </div>
        </div>
        <textarea ref={logRef} className="raw-log-output" aria-label={moteText("原始日志")} readOnly spellCheck={false} wrap={wrap?'soft':'off'} value={rawLog} placeholder={snapshot.enabled?moteText("暂无日志。"):moteText("运行日志已关闭，历史仍可查看。")}/>
        <p className="fine-print" role="status">{copyStatus}</p>
      </section>
    </>}
  </section>;
}
