import {useEffect,useState} from 'react';
import {type Api,errorMessage} from './api';

export function FileProcessingSettings({api}:{api:Api}){
 const [saved,setSaved]=useState<any>(null),[keys,setKeys]=useState<Record<string,string>>({}),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[sources,setSources]=useState<{id:string;name:string}[]>([]);
 useEffect(()=>{void api.request('/api/file-processing').then(setSaved).catch(e=>setMessage(errorMessage(e)));void api.request<any>('/api/sources').then(r=>setSources(r.items)).catch(()=>{});},[api]);
 const settings=saved?.settings;
 function change(k:string,v:unknown){setSaved((s:any)=>s?{...s,settings:{...s.settings,[k]:v}}:s);}
 const password=(key:string,label:string)=><label>{label}<input type="password" autoComplete="off" value={keys[key]??''} onChange={e=>setKeys(v=>({...v,[key]:e.target.value}))} placeholder={settings[key+'Configured']?'已配置；留空保留':'可留空'}/>{settings[key+'Configured']&&<button type="button" className="text-button" onClick={()=>change(key,null)}>清除已保存密钥</button>}</label>;
 const options=<><option value="archive">仅归档原件</option>{saved?.processors?.filter((p:any)=>p.stage==='extract'&&p.mediaTypes.includes('audio/')).map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</>;
 return <details className="source-item file-processing-settings"><summary>中央文件处理设置</summary><p>原件归档后，按格式及来源选择处理方式。已完成的文件保持原结果；可在文件详情中手动重新处理。</p>{saved&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);try{setSaved(await api.request('/api/file-processing',{method:'PUT',body:JSON.stringify({revision:saved.revision,settings:{...settings,...Object.fromEntries(Object.entries(keys).filter(([,v])=>v))}})}));setKeys({});setMessage('设置已保存，等待任务将使用新配置。');}catch(error){setMessage(errorMessage(error));}finally{setBusy(false);}}}>
 <label><input type="checkbox" checked={settings.enabled} onChange={e=>change('enabled',e.target.checked)}/>启用中央文件处理</label>
 <label>录音默认处理方式<select aria-label="录音处理方式" value={settings.audioProcessor} onChange={e=>change('audioProcessor',e.target.value)}>{options}</select></label>
 <fieldset><legend>本地多人录音</legend><p>本地转写 → 说话人分离 → 时间对齐。保留未校正原文；此方式不会自动调用云端摘要或云端向量服务。</p>
 <label>本地录音服务<input aria-label="本地录音服务" value={settings.localEndpoint} onChange={e=>change('localEndpoint',e.target.value)}/></label>
 {password('localWorkerApiKey','本地服务密钥')}
 <label>预期说话人数<input aria-label="预期说话人数" type="number" min="1" max="16" placeholder="留空自动识别" value={settings.speakerCount??''} onChange={e=>change('speakerCount',e.target.value===''?null:Number(e.target.value))}/></label>
 <button type="button" className="button" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await api.request<any>('/api/file-processing/test-local',{method:'POST',body:'{}'});setMessage(`已保存配置检测：本地转写${r.asr?'就绪':'未就绪'}，说话人分离${r.diarization?'就绪':'未就绪'}。`);}catch(e){setMessage(errorMessage(e));}finally{setBusy(false);}}}>检测已保存的本地服务</button>
 <details><summary>可选：本地语义分组与复核模型</summary><p>需要另行启动本地语言模型。未配置时，仍可完成转写、时间对齐和导出；不会回退到云端模型。</p>
 <label><input type="checkbox" checked={settings.semanticTurns} onChange={e=>change('semanticTurns',e.target.checked)}/>结合语义合并自然发言轮次（最多 200 轮；不改写文字）</label>
 <label>本地语言模型地址<input value={settings.localModelEndpoint} onChange={e=>change('localModelEndpoint',e.target.value)}/></label>
 <label>模型名称<input value={settings.localModelName} onChange={e=>change('localModelName',e.target.value)}/></label>{password('localModelApiKey','本地模型密钥')}</details></fieldset>
 <details><summary>转写接口与图片处理</summary><p>服务采用 Mote 文件处理接口，可连接云服务适配器或自行开发插件。</p>
 <label>转写接口地址<input aria-label="转写服务地址" value={settings.endpoint} onChange={e=>change('endpoint',e.target.value)}/></label>{password('apiKey','转写接口密钥')}
 <label>图片文字提取接口<input value={settings.imageEndpoint} onChange={e=>change('imageEndpoint',e.target.value)} placeholder="留空仅归档"/></label>
 <label><input type="checkbox" checked={settings.allowRemote} onChange={e=>change('allowRemote',e.target.checked)}/>允许向配置的远端 HTTPS 处理接口发送原文件</label>
 <label><input type="checkbox" checked={settings.summarize} onChange={e=>change('summarize',e.target.checked)}/>使用问答模型生成摘要（本地多人录音除外；提取文本会发送给该模型）</label></details>
 <details><summary>按来源设置</summary>{sources.map(source=><label key={source.id}>{source.name}<select value={settings.sourceProfiles[source.id]??'inherit'} onChange={e=>change('sourceProfiles',{...settings.sourceProfiles,[source.id]:e.target.value})}><option value="inherit">使用格式默认设置</option>{options}</select></label>)}</details>
 <label>每日处理音频预算（分钟）<input type="number" min="1" max="100000" value={settings.dailyAudioMinutes} onChange={e=>change('dailyAudioMinutes',Number(e.target.value))}/></label>
 <label>单文件处理超时（分钟）<input type="number" min="1" max="60" value={settings.timeoutMs/60000} onChange={e=>change('timeoutMs',Number(e.target.value)*60000)}/></label>
 <button className="button" disabled={busy}>保存处理设置</button></form>}{message&&<p role="status">{message}</p>}</details>;
}
