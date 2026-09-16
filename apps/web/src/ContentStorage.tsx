import {useEffect,useState} from 'react';
import {type Api,errorMessage} from './api';

interface StorageState {
  enabled:boolean;
  job:{state:'idle'|'running'|'completed'|'cancelled';total:number;processed:number;converted:number;skipped:number;failed:number};
}
export function ContentStorage({api,onChange}:{api:Api;onChange?:()=>void}) {
  const [state,setState]=useState<StorageState>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      try{const next=await api.request<StorageState>('/api/content-storage');if(active){setState(next);if(next.job.state==='running')timer=setTimeout(()=>void poll(),500);}}
      catch(e){if(active)setError(errorMessage(e));}
    };
    void poll();return()=>{active=false;if(timer)clearTimeout(timer);};
  },[api,state?.job.state]);
  async function change(path:string,method:string,body:object) {
    setBusy(true);setError('');
    try{setState(await api.request<StorageState>(path,{method,body:JSON.stringify(body)}));onChange?.();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  const running=state?.job.state==='running';
  return <section className="panel" aria-labelledby="content-storage-title">
    <div className="section-heading"><div><h2 id="content-storage-title">内容存储</h2><p>中央节点 · 默认明文保存</p></div></div>
    <label className="check-field"><input type="checkbox" checked={state?.enabled??false} disabled={!state||busy||running}
      onChange={event=>void change('/api/content-storage','PUT',{enabled:event.target.checked})}/>加密后续保存的图片和原件</label>
    <p className="fine-print">开关立即生效，已有文件保持原格式并可继续读取。记录正文和索引存储在 SQLite 中；客户端的本地存储可在各自开发者选项中设置。</p>
    <div className="diagnostics-actions">
      <button className="button subtle" disabled={!state||state.enabled||busy||running} onClick={()=>void change('/api/content-storage/decrypt','POST',{})}>一次性批量解密</button>
      {running&&<button className="button subtle" disabled={busy} onClick={()=>void change('/api/content-storage/decrypt/cancel','POST',{})}>取消解密</button>}
    </div>
    <p className="fine-print">关闭上方加密后，可将已有图片、原件和待上传分片逐项转换为明文。任务在后台运行，离开页面仍会继续；取消后保留已完成结果，可再次运行。连接凭据不参与转换。</p>
    {!state&&!error&&<p role="status">正在读取存储设置…</p>}
    {state&&state.job.state!=='idle'&&<div role="status" aria-live="polite">
      {running?'正在解密':state.job.state==='cancelled'?'已取消':'处理完成'} · 已检查 {state.job.processed}/{state.job.total} 项 · 已转换 {state.job.converted} 项 · 无需转换 {state.job.skipped} 项 · 失败 {state.job.failed} 项
      {running&&<progress aria-label="批量解密进度" value={state.job.processed} max={Math.max(1,state.job.total)}/>}
      {state.job.failed>0&&<p>失败项保留原文件，请检查原密钥和存储空间后重试。</p>}
    </div>}
    {error&&<p className="notice error" role="alert">{error}</p>}
  </section>;
}
