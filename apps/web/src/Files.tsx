import {useEffect,useRef,useState} from 'react';
import {type Api,bytes,dateTime,errorMessage} from './api';
import {AnswerMarkdown} from './AnswerMarkdown';

type FileRow={captureId:string;sourceId:string;sizeBytes:number;hasOriginal:boolean;originMissing:boolean;item:{title:string;layer:string;observedAt:string;mimeType?:string};job:null|{state:string;error?:string;summary_state:string};artifacts:{id:string;kind:string;complete?:boolean;sections?:{answer:string;citationIds:string[]}[]}[]};
const errors:Record<string,string>={not_configured:'请配置中央处理服务',unsupported_format:'此格式仅归档原件',provider_failed:'转写服务未完成，请检查服务后重试',processing_limit:'超过处理大小或时长预算',daily_budget:'等待次日音频预算',summary_failed:'摘要生成失败，可单独重试'};
const states:Record<string,string>={waiting:'等待处理',running:'处理中',succeeded:'已完成',blocked:'等待配置或格式支持',failed:'处理失败'};

export function Files({api,onOpen}:{api:Api;onOpen:(id:string)=>void}){
 const [items,setItems]=useState<FileRow[]>([]),[cursor,setCursor]=useState<string|null>(null),[query,setQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[sourceId,setSourceId]=useState(''),[mimePrefix,setMimePrefix]=useState(''),[sources,setSources]=useState<{id:string;name:string;deviceId:string}[]>([]);
 async function load(more=false){setBusy(true);setError('');try{const r=await api.request<{items:FileRow[];nextCursor:string|null}>('/api/files?'+new URLSearchParams({query,...(sourceId?{sourceId}:{}),...(mimePrefix?{mimePrefix}:{}),...(more&&cursor?{cursor}:{})}));setItems(v=>more?[...v,...r.items]:r.items);setCursor(r.nextCursor);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 useEffect(()=>{void load();void api.request<{items:{id:string;name:string;deviceId:string}[]}>('/api/sources').then(r=>setSources(r.items)).catch(()=>{});},[api]);
 return <section><h2>文件归档</h2><p>集中浏览手机、电脑和 NAS 来源。手机删除原件后，中央已归档内容仍保留。</p><form className="source-toolbar" onSubmit={e=>{e.preventDefault();void load();}}><input aria-label="文件名" placeholder="按文件名或目录查找" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="文件来源" value={sourceId} onChange={e=>setSourceId(e.target.value)}><option value="">全部来源</option>{sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><select aria-label="文件格式" value={mimePrefix} onChange={e=>setMimePrefix(e.target.value)}><option value="">全部格式</option><option value="audio/">录音</option><option value="text/">文本</option></select><button className="button" disabled={busy}>查找 / 刷新</button></form>{error&&<p className="error-banner" role="alert">{error}</p>}{!items.length&&!busy&&<p className="muted">尚无匹配文件。在手机“日历与文件”中选择录音目录后，文件会出现在这里。</p>}<div className="source-list">{items.map(f=><button className="source-item file-card" key={f.captureId} onClick={()=>onOpen(f.captureId)}><strong>{f.item.title}</strong><span>{bytes(f.sizeBytes)} · {f.hasOriginal?'原件已归档':'仅元信息引用'}{f.originMissing?' · 原位置已不可见':''}</span><span>{dateTime(f.item.observedAt)} · {f.job?states[f.job.state]??f.job.state:'无需内容处理'}</span></button>)}</div>{cursor&&<button disabled={busy} className="button" onClick={()=>void load(true)}>继续加载</button>}<FileProcessingSettings api={api}/></section>;
}

export function FileDetail({api,id,startMs=0,onOpen}:{api:Api;id:string;startMs?:number;onOpen:(id:string)=>void}){
 const [file,setFile]=useState<FileRow|null>(null),[error,setError]=useState(''),[chunks,setChunks]=useState<any[]>([]),[offset,setOffset]=useState<number|null>(0),[url,setUrl]=useState('');
 const player=useRef<HTMLAudioElement>(null);
 useEffect(()=>{if(player.current)player.current.currentTime=startMs/1000;},[startMs,url]);
 async function load(){setFile(await api.request<FileRow>('/api/files/'+encodeURIComponent(id)));}
 useEffect(()=>{let active=true;setFile(null);setError('');setChunks([]);setOffset(0);setUrl('');void api.request<FileRow>('/api/files/'+encodeURIComponent(id)).then(f=>{if(active)setFile(f);}).catch(()=>{});return()=>{active=false;};},[api,id]);
 async function action(fn:()=>Promise<void>){try{setError('');await fn();}catch(e){setError(errorMessage(e));}}
 if(!file)return null;
 return <section className="file-detail"><h3>{file.item.title}</h3><p>{bytes(file.sizeBytes)} · {file.hasOriginal?'原始文件已保存':'仅保存引用'}{file.originMissing?' · 来源已不可见，中央归档仍可使用':''}</p>
 {file.hasOriginal&&<div className="source-toolbar"><button className="button" onClick={()=>void action(async()=>{const r=await api.request<{url:string}>('/api/files/'+id+'/playback',{method:'POST',body:'{}'});setUrl(r.url);})}>加载原件 / 回听</button><button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/playback',{method:'POST',body:'{}'});const a=document.createElement('a');a.href='/api/files/'+id+'/content?download=1';a.download=file.item.title;a.click();})}>下载原件</button></div>}
 {url&&file.item.mimeType?.startsWith('audio/')&&<audio onError={()=>setError('浏览器无法播放此编码，可下载原件使用本机播放器打开。')} ref={player} controls src={url} preload="metadata" onLoadedMetadata={()=>{if(player.current)player.current.currentTime=startMs/1000;}}/>}
 <p>转写：{file.job?states[file.job.state]??file.job.state:'不读取内容'}；摘要：{file.job?states[file.job.summary_state]??file.job.summary_state:'无'}{file.job?.error&&`（${errors[file.job.error]??'处理未完成'}）`}</p>
 {file.job&&<div className="source-toolbar"><button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/retry',{method:'POST',body:'{}'});await load();})}>重新转写 / 提取</button><button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/retry',{method:'POST',body:JSON.stringify({stage:'summary'})});await load();})}>重新生成摘要</button><button className="button" onClick={()=>void action(load)}>刷新处理状态</button></div>}
 {file.artifacts.filter(a=>a.kind==='summary').map(a=><div key={a.id}><h4>模型摘要</h4>{a.sections?.map((s,i)=><AnswerMarkdown key={i} onOpen={onOpen} answer={{answer:s.answer,runId:a.id,trace:[],citations:s.citationIds.map(id=>({id,capturedAt:file.item.observedAt,appName:file.item.title,excerpt:''}))}}/>)}</div>)}
 {chunks.length>0&&<h4>转写 / 提取片段</h4>}{chunks.map(c=><div key={c.id} className="source-item"><button className="text-button" onClick={()=>{if(player.current&&c.fileEvidence?.startMs!==undefined)player.current.currentTime=c.fileEvidence.startMs/1000;}}>{c.fileEvidence?.startMs!==undefined?`${Math.floor(c.fileEvidence.startMs/1000)} 秒`:'文本片段'}</button><p className="file-text">{c.ocrText}</p></div>)}
 {offset!==null&&file.job?.state==='succeeded'&&<button className="button" onClick={()=>void action(async()=>{const r=await api.request<{items:any[];nextOffset:number|null}>('/api/files/'+id+'/chunks?offset='+offset);setChunks(v=>[...v,...r.items]);setOffset(r.nextOffset);})}>{chunks.length?'继续展开':'展开转写 / 原文片段'}</button>}
 {error&&<p role="alert" className="error-banner">{error}</p>}</section>;
}

function FileProcessingSettings({api}:{api:Api}){
 const [saved,setSaved]=useState<{revision:string;settings:any}|null>(null),[key,setKey]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{void api.request<any>('/api/file-processing').then(setSaved).catch(e=>setMessage(errorMessage(e)));},[api]);
 function change(k:string,v:unknown){setSaved(s=>s?{...s,settings:{...s.settings,[k]:v}}:s);}
 return <details className="source-item"><summary>中央文件处理设置</summary><p>原件先归档，转写由中央节点调用配置的处理服务。默认地址用于中央本机服务，也可自行实现相同接口。</p>{saved&&<form onSubmit={async e=>{e.preventDefault();try{const result=await api.request<any>('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:saved.revision,settings:{...saved.settings,...(key?{apiKey:key}:{})}})});setSaved(result);setKey('');setMessage('设置已保存，等待中的任务将使用新配置。');}catch(error){setMessage(errorMessage(error));}}}>
 <label><input type="checkbox" checked={saved.settings.enabled} onChange={e=>change('enabled',e.target.checked)}/>启用中央转写与文字提取</label>
 <label>转写服务地址<input aria-label="转写服务地址" value={saved.settings.endpoint} onChange={e=>change('endpoint',e.target.value)}/></label>
 <label><input type="checkbox" checked={saved.settings.allowRemote} onChange={e=>change('allowRemote',e.target.checked)}/>允许把原音频发送到所填远端 HTTPS 服务</label>
 <label>服务密钥<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder={saved.settings.apiKeyConfigured?'已配置；留空保留':'本机服务可留空'}/></label>
 {saved.settings.apiKeyConfigured&&<button type="button" className="text-button" onClick={()=>change('apiKey',null)}>清除已保存的服务密钥</button>}
 <label><input type="checkbox" checked={saved.settings.summarize} onChange={e=>change('summarize',e.target.checked)}/>使用现有问答模型生成摘要（转写文本会发送给该模型）</label>
 <label>每日处理音频预算（分钟）<input type="number" min="1" max="100000" value={saved.settings.dailyAudioMinutes} onChange={e=>change('dailyAudioMinutes',Number(e.target.value))}/></label>
 <button className="button">保存处理设置</button></form>}{message&&<p role="status">{message}</p>}</details>;
}
