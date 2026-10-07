import {useEffect,useState} from 'react';
import {useResource} from './useResource';
import {useUnsavedChanges} from './unsaved';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import type {ProcessingProfile} from '@mote/shared';

type Settings={providerRevision:string;enabled:boolean;ocrProcessorId:string;ocrEndpoint:string;allowExternalProcessing:boolean;allowQueryImages:boolean;understandingEnabled:boolean;profileId?:string};
type View={settings:Settings;model:{model?:string;profileId?:string}|null;jobs:{kind:string;state:string;count:number;autoEligible:number}[];backfills:{id:string;state:string;queued:number}[]};
type ModelState={state:string;bytes:number;totalBytes:number;source:string;error?:string;runtimeReady:boolean};
export function PerceptionSettings({api,onMemory,onAdvanced}:{api:Api;onMemory?:()=>void;onAdvanced?:()=>void}){
 const read=useResource<View>(api,'/api/perception',5000),policy=useResource<{policy:{profiles:ProcessingProfile[]};processors:{id:string;stage:string;mediaTypes:string[]}[]}>(api,'/api/file-processing');
 const models=useResource<{ocr:ModelState}>(api,'/api/media-models',5000),ocr=models.data?.ocr;
 const [settings,setSettings]=useState<Settings>(),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const [range,setRange]=useState({after:'',before:'',sourceId:'',mode:'complete' as 'complete'|'recompute'}),[preview,setPreview]=useState<{token:string;count:number}|null>(null);
 const sources=useResource<{items:{id:string;name:string}[]}>(api,'/api/sources');
 useUnsavedChanges(dirty);
 useEffect(()=>{setSettings(undefined);setDirty(false);setError('');setSaved(false);setPreview(null);},[api]);
 useEffect(()=>{if(read.data&&!dirty)setSettings(read.data.settings);},[read.data,dirty]);
 const change=<K extends keyof Settings>(key:K,value:Settings[K])=>{setSettings(current=>current?{...current,[key]:value}:current);setDirty(true);setSaved(false);};
 async function action(work:()=>Promise<void>){setBusy(true);setError('');try{await work();}catch(error){setError(errorMessage(error));}finally{setBusy(false);}}
 const profiles=policy.data?.policy?.profiles.filter(p=>p.processorId==='archive'||p.imageRecipe||policy.data?.processors?.some(x=>x.id===p.processorId&&x.stage==='extract'&&x.mediaTypes.some(t=>t.startsWith('image/'))))??[];
 return <section className="panel perception-settings"><h2>{moteText('图片')}</h2><p>{moteText('正式接纳的截图、导入图片、同步图片和资料附件共享中央方案。原件先保存，各步骤独立完成。')}</p>
 {(error||read.error!==undefined)&&<p role="alert">{error||errorMessage(read.error)}</p>}
 {settings&&read.error===undefined&&<form onSubmit={e=>{e.preventDefault();void action(async()=>{const result=await api.request<View>('/api/perception',{method:'PUT',body:JSON.stringify(settings)});setSettings(result.settings);setDirty(false);setSaved(true);read.refresh();policy.refresh();});}}>
 <label><input type="checkbox" checked={settings.enabled} onChange={e=>change('enabled',e.target.checked)}/>{moteText('自动处理新图片')}</label>
 <label>{moteText('中央图片方案')}<select value={settings.profileId??''} onChange={e=>change('profileId',e.target.value)}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
 <p>{moteText('文字识别服务')} · {settings.ocrEndpoint||moteText('仅保存原件')}</p>
 <label><input type="checkbox" checked={settings.understandingEnabled} onChange={e=>change('understandingEnabled',e.target.checked)}/>{moteText('后台理解画面与来源上下文')}</label>
 <p>{moteText('内容理解使用中央文件分析模型：{0}',read.data?.model?.model??moteText('未配置'))}</p>
 <p>{moteText('记忆整理')} · {moteText('持续整理新资料')} {onMemory&&<button className="text-button" type="button" onClick={onMemory}>{moteText('查看记忆设置')}</button>}</p>
 <div className="policy-card"><strong>{moteText('本地 OCR 模型：')}{ocr?.state??moteText('读取中')}</strong>{ocr?.state==='ready'&&<p role="status">{ocr.runtimeReady?moteText('OCR Worker 已就绪'):moteText('模型已安装，正在准备本地 OCR 服务；就绪后会自动处理')}</p>}{ocr&&ocr.totalBytes>0&&['downloading','verifying','installing'].includes(ocr.state)&&<progress value={ocr.bytes} max={ocr.totalBytes}/>} {ocr?.state!=='ready'&&<button type="button" className="button" disabled={busy||['downloading','verifying','installing'].includes(ocr?.state??'')} onClick={()=>void action(async()=>{await api.request('/api/media-models/ocr/install',{method:'POST',body:JSON.stringify({source:'auto'})});models.refresh();})}>{moteText('下载并安装 OCR 模型')}</button>}{ocr?.error&&<p role="alert">{ocr.error}</p>}</div>
 <details><summary>{moteText('高级设置')}</summary><p>{moteText('服务、插件参数与来源覆盖在文件处理策略中维护。图片设置通过引用复用这些配置。')}</p>{onAdvanced&&<button type="button" className="button" onClick={onAdvanced}>{moteText('查看处理策略')}</button>}
 <label>{moteText('处理模型／配置版本')}<input value={settings.providerRevision} maxLength={128} required onChange={e=>change('providerRevision',e.target.value)}/></label>
 <label><input type="checkbox" checked={settings.allowExternalProcessing} onChange={e=>change('allowExternalProcessing',e.target.checked)}/>{moteText('允许图片发往已选择的远程 OCR 服务')}</label>
 <label><input type="checkbox" checked={settings.allowQueryImages} onChange={e=>change('allowQueryImages',e.target.checked)}/>{moteText('允许查询模型按需读取已发现记录的原图（可能发往所选模型服务）')}</label></details>
 <button className="button primary" disabled={busy} type="submit">{moteText('保存图片设置')}</button>{saved&&<span role="status">{moteText('已保存')}</span>}</form>}
 <div className="policy-card"><h3>{moteText('补处理已有图片')}</h3><p>{moteText('选择范围后一次安排，中央会持续分批执行。补齐会复用已有成果；重新计算会产生新版本。')}</p>
 <label>{moteText('开始日期')}<input type="date" value={range.after} onChange={e=>{setRange({...range,after:e.target.value});setPreview(null);}}/></label><label>{moteText('结束日期')}<input type="date" value={range.before} onChange={e=>{setRange({...range,before:e.target.value});setPreview(null);}}/></label>
 <label>{moteText('来源')}<select value={range.sourceId} onChange={e=>{setRange({...range,sourceId:e.target.value});setPreview(null);}}><option value="">{moteText('全部来源')}</option>{sources.data?.items.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
 <label>{moteText('处理方式')}<select value={range.mode} onChange={e=>{setRange({...range,mode:e.target.value as typeof range.mode});setPreview(null);}}><option value="complete">{moteText('补齐未完成步骤')}</option><option value="recompute">{moteText('重新计算已有结果')}</option></select></label>
 <button className="button" type="button" disabled={busy||dirty} onClick={()=>void action(async()=>{setPreview(await api.request('/api/perception/ocr/historical-preview',{method:'POST',body:JSON.stringify({mode:range.mode,...(range.sourceId?{sourceId:range.sourceId}:{}),...(range.after?{after:new Date(range.after+'T00:00:00').toISOString()}:{}),...(range.before?{before:new Date(new Date(range.before+'T00:00:00').getTime()+86400000).toISOString()}:{} )})}));})}>{moteText('预览处理范围')}</button>
 {preview&&<p role="status">{moteText('范围内共 {0} 张图片',preview.count)}{preview.count>0&&<button className="button" type="button" disabled={busy} onClick={()=>void action(async()=>{await api.request('/api/perception/ocr/historical-process',{method:'POST',body:JSON.stringify({token:preview.token})});setPreview(null);read.refresh();})}>{moteText('安排全部图片')}</button>}</p>}
 {read.data?.backfills.map(b=><p key={b.id}>{moteText('已安排 {0} 张图片',b.queued)} · {b.state==='succeeded'?moteText('范围已全部安排'):moteText('正在分批安排')}</p>)}</div>
 <h3>{moteText('处理状态')}</h3><button className="button" type="button" onClick={()=>{read.refresh();models.refresh();}}>{moteText('刷新')}</button><ul>{read.data?.jobs.map(j=><li key={j.kind+j.state+j.autoEligible}>{j.kind==='ocr'?moteText('文字识别'):j.kind==='understanding'?moteText('内容理解'):j.kind} · {j.autoEligible?j.state:moteText('历史未安排')} · {j.count}</li>)}</ul></section>;
}
