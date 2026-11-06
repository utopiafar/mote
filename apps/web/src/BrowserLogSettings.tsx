import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {initializeBrowserLogging,readBrowserLogPolicy,saveBrowserLogPolicy,type BrowserLogPolicy} from './logger';
import {browserLogWriteFailed,readStoredBrowserLogs} from './browser-log-store';

export function BrowserLogSettings({profile}:{profile?:string}) {
  const [policy,setPolicy]=useState<BrowserLogPolicy>(readBrowserLogPolicy);
  const [message,setMessage]=useState(''),[logs,setLogs]=useState<string>();
  useEffect(()=>{setPolicy(initializeBrowserLogging(profile));},[profile]);
  useEffect(()=>{const changed=(event:StorageEvent)=>{if(event.key==='mote-browser-log-settings')setPolicy(initializeBrowserLogging(profile));};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[profile]);
  async function read() {
    try {const rows=await readStoredBrowserLogs();const text=rows.map(row=>JSON.stringify(row)).join('\n');setLogs(text);setMessage(browserLogWriteFailed()?moteText('日志写入失败，请检查浏览器存储。'):'');return text;}
    catch {setMessage(moteText('日志读取失败，请检查浏览器存储。'));return undefined;}
  }
  function save() {
    try {setPolicy(saveBrowserLogPolicy(policy));setMessage(moteText('已保存，立即生效。'));}
    catch {setMessage(moteText('无法持久保存设置，请检查存储空间'));}
  }
  async function download() {
    const text=await read();if(text===undefined)return;
    const url=URL.createObjectURL(new Blob([text],{type:'application/x-ndjson'}));
    const link=document.createElement('a');link.href=url;link.download='mote-browser-logs.ndjson';link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
  }
  return <section className="panel runtime-settings">
    <h2>{moteText('当前浏览器日志')}</h2>
    <label className="preference-toggle"><span>{moteText('记录运行日志')}</span><input type="checkbox" checked={policy.enabled} onChange={event=>setPolicy({...policy,enabled:event.target.checked})}/></label>
    <label>{moteText('日志级别')}<select value={policy.level} onChange={event=>setPolicy({...policy,level:event.target.value as BrowserLogPolicy['level']})}>{['debug','info','warn','error'].map(level=><option key={level} value={level}>{level.toUpperCase()}</option>)}</select></label>
    <p className="fine-print">{moteText('保存在当前浏览器的站点存储中；清除站点数据会删除日志。')}</p>
    <div className="diagnostics-actions"><button className="button" type="button" onClick={save}>{moteText('保存日志设置')}</button><button className="button subtle" type="button" onClick={()=>void read()}>{moteText('查看日志')}</button><button className="button subtle" type="button" onClick={()=>void download()}>{moteText('导出日志')}</button></div>
    {message&&<p role="status">{message}</p>}
    {logs!==undefined&&<textarea className="raw-log-output" aria-label={moteText('原始日志')} readOnly value={logs} />}
  </section>;
}
