import {useEffect,useState} from 'react';
import {type Api,errorMessage} from './api';
type Settings={providerRevision:string;enabled:boolean;ocrEndpoint:string;semanticEndpoint:string;semanticMode:'manual'|'realtime'|'batch';batchMinutes:number;batchSize:number;allowExternalProcessing:boolean;allowQueryImages:boolean};
type View={recent:{id:string;kind:string;state:string;error?:string}[];settings:Settings;jobs:{kind:string;state:string;count:number}[]};
export function PerceptionSettings({api}:{api:Api}){
 const [view,setView]=useState<View>(),[settings,setSettings]=useState<Settings>(),[error,setError]=useState(''),[saved,setSaved]=useState(false),[busy,setBusy]=useState(false);
 useEffect(()=>{const c=new AbortController();api.request<View>('/api/perception',{signal:c.signal}).then(v=>{setView(v);setSettings(v.settings);}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();},[api]);
 const change=<K extends keyof Settings>(key:K,value:Settings[K])=>{setSettings(s=>s?{...s,[key]:value}:s);setSaved(false);};
 return <section className="panel"><h2>中央感知</h2><p>截图先可靠归档，再独立生成 L1 OCR 与 L2 语义结果。识别失败不影响原图归档，语义失败不阻塞已完成的文字检索。</p>{error&&<p role="alert">{error}</p>}{settings&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const v=await api.request<View>('/api/perception',{method:'PUT',body:JSON.stringify(settings)});setView(v);setSettings(v.settings);setSaved(true);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}}>
 <label><input type="checkbox" checked={settings.enabled} onChange={e=>change('enabled',e.target.checked)}/>启用中央截图处理</label>
 <label>处理模型／配置版本<input value={settings.providerRevision} maxLength={128} required onChange={e=>change('providerRevision',e.target.value)}/></label><label>OCR Worker 地址<input type="url" value={settings.ocrEndpoint} onChange={e=>change('ocrEndpoint',e.target.value)}/></label><p>使用已有 image.http 图片处理接口；未配置时保留待处理任务，不伪造识别结果。</p>
 <label>语义理解 Worker 地址<input type="url" value={settings.semanticEndpoint} onChange={e=>change('semanticEndpoint',e.target.value)}/></label>
 <label>语义理解时机<select value={settings.semanticMode} onChange={e=>change('semanticMode',e.target.value as Settings['semanticMode'])}><option value="manual">手动处理（默认）</option><option value="realtime">实时后台处理</option><option value="batch">分批处理</option></select></label>
 <label>分批等待（分钟）<input type="number" min="1" max="1440" value={settings.batchMinutes} onChange={e=>change('batchMinutes',e.target.valueAsNumber)}/></label>
 <label>每轮最多处理数<input type="number" min="1" max="100" value={settings.batchSize} onChange={e=>change('batchSize',e.target.valueAsNumber)}/></label>
 <label><input type="checkbox" checked={settings.allowExternalProcessing} onChange={e=>change('allowExternalProcessing',e.target.checked)}/>允许将截图发往上述非本机 Worker（默认关闭）</label>
 <label><input type="checkbox" checked={settings.allowQueryImages} onChange={e=>change('allowQueryImages',e.target.checked)}/>允许查询模型按需读取已发现记录的原图（可能发往所选模型服务）</label><p>查询先读取 OCR／语义派生结果。只有模型显式调用读图工具才披露图片；不自动附加图像。截图中的文字始终作为不可信证据。</p>
 <button disabled={busy} type="submit">{busy?'保存中…':'保存中央感知设置'}</button>{saved&&<span role="status">已保存</span>}
 </form>}<ul>{view?.jobs.map(j=><li key={j.kind+j.state}>{j.kind==='ocr'?'OCR':'语义理解'} · {j.state} · {j.count}</li>)}</ul><h3>最近处理任务</h3>{view?.recent.map(j=><div key={j.id+j.kind}><code>{j.id}</code> · {j.kind} · {j.state} {j.error&&`· ${j.error}`} <button type="button" disabled={busy||j.state==='running'} onClick={async()=>{setBusy(true);try{await api.request(`/api/perception/${j.id}/retry`,{method:'POST',body:JSON.stringify({kind:j.kind})});setView(await api.request<View>('/api/perception'));}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}}>{j.state==='succeeded'?'重新处理':'立即处理／重试'}</button></div>)}</section>;
}
