import {useResource} from './useResource';
import {resources} from './resource-cache';
import {useOperationUpdates} from './useOperationUpdates';
import { moteText } from '@mote/shared/i18n';
import {useEffect,useRef,useState} from 'react';
import {type Api,bytes,dateTime,errorMessage} from './api';
import {FileProcessingSettings} from './FileProcessingSettings';
import {FileReview} from './FileReview';
import {AnswerMarkdown} from './AnswerMarkdown';

type FileRow={processingPolicy?:{applied:any;current:any;legacyRevision:string|null};captureId:string;sourceId:string;sizeBytes:number;hasOriginal:boolean;originMissing:boolean;item:{document?:{fileIndex?:import('@mote/shared').FileIndex};text?:string;title:string;layer:string;observedAt:string;mimeType?:string};job:null|{state:string;error?:string;summary_state:string;local_only?:number;execution?:import('@mote/shared').ExecutionEnvelope};steps?:{step:string;state:string;attempts:number;execution?:import('@mote/shared').ExecutionEnvelope}[];artifacts:{id:string;kind:string;complete?:boolean;sections?:{answer:string;citationIds:string[]}[]}[]};
const errors:Record<string,string>={archive_only:moteText("仅归档原件"),processor_not_configured:moteText("处理插件或本地模型尚未配置"),not_configured:moteText("请配置中央处理服务"),unsupported_format:moteText("此格式仅归档原件"),provider_failed:moteText("转写服务未完成，请检查服务后重试"),processing_limit:moteText("超过处理大小或时长预算"),daily_budget:moteText("等待次日音频预算"),summary_failed:moteText("摘要生成失败，可单独重试")};
const states:Record<string,string>={waiting:moteText("等待处理"),running:moteText("处理中"),succeeded:moteText("已完成"),blocked:moteText("等待配置或格式支持"),failed:moteText("处理失败")};

export function Files({api,onOpen}:{api:Api;onOpen:(id:string)=>void}){
 const [query,setQuery]=useState(''),[sourceId,setSourceId]=useState(''),[mimePrefix,setMimePrefix]=useState('');
 const [applied,setApplied]=useState({query:'',sourceId:'',mimePrefix:''}),[cursor,setCursor]=useState<string|null>(null),[previous,setPrevious]=useState<FileRow[]>([]);
 const path='/api/files?'+new URLSearchParams({query:applied.query,...(applied.sourceId?{sourceId:applied.sourceId}:{}),...(applied.mimePrefix?{mimePrefix:applied.mimePrefix}:{}),...(cursor?{cursor}:{})});
 const page=useResource<{items:FileRow[];nextCursor:string|null}>(api,path),sourceList=useResource<{items:{id:string;name:string;deviceId:string}[]}>(api,'/api/sources');
 useOperationUpdates(api);
 const items=[...previous,...(page.data?.items??[]).filter(item=>!previous.some(old=>old.captureId===item.captureId))],nextCursor=page.data?.nextCursor,sources=sourceList.data?.items??[],busy=page.loading;
 const error=page.error?errorMessage(page.error):sourceList.error?errorMessage(sourceList.error):'';
 function load(more=false){if(more&&nextCursor){setPrevious(items);setCursor(nextCursor);}else{setApplied({query,sourceId,mimePrefix});setPrevious([]);setCursor(null);resources(api).invalidate(key=>key.startsWith('/api/files?'));}}

 return <section><h2>{moteText("文件归档")}</h2><p>{moteText("集中浏览手机、电脑和 NAS 来源。手机删除原件后，中央已归档内容仍保留。")}</p><form className="source-toolbar" onSubmit={e=>{e.preventDefault();void load();}}><input aria-label={moteText("文件名")} placeholder={moteText("按文件名或目录查找")} value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label={moteText("文件来源")} value={sourceId} onChange={e=>setSourceId(e.target.value)}><option value="">{moteText("全部来源")}</option>{sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><select aria-label={moteText("文件格式")} value={mimePrefix} onChange={e=>setMimePrefix(e.target.value)}><option value="">{moteText("全部格式")}</option><option value="audio/">{moteText("录音")}</option><option value="text/">{moteText("文本")}</option><option value="image/">{moteText("图片")}</option></select><button className="button" disabled={busy}>{moteText("查找 / 刷新")}</button></form>{error&&<p className="error-banner" role="alert">{error}</p>}{!items.length&&!busy&&!error&&<p className="muted">{moteText("尚无匹配文件。在手机“日历与文件”中选择录音目录后，文件会出现在这里。")}</p>}<div className="source-list">{items.map(f=><button className="source-item file-card" key={f.captureId} onClick={()=>onOpen(f.captureId)}><strong>{f.item.title}</strong><span>{bytes(f.sizeBytes)} · {fileAvailability(f)}{f.originMissing?moteText(" · 原位置已不可见"):''}</span><span>{dateTime(f.item.observedAt)} · {f.job?states[f.job.state]??f.job.state:moteText("无需内容处理")}</span></button>)}</div>{nextCursor&&<button disabled={busy} className="button" onClick={()=>void load(true)}>{moteText("继续加载")}</button>}<FileProcessingSettings api={api}/></section>;
}

export function FileDetail(props:{api:Api;id:string;startMs?:number;onOpen:(id:string)=>void}){return <FileDetailContents key={props.id} {...props}/>;}
function FileDetailContents({api,id,startMs=0,onOpen}:{api:Api;id:string;startMs?:number;onOpen:(id:string)=>void}){
 const {data:file,error:readError,loading,refresh}=useResource<FileRow>(api,'/api/files/'+encodeURIComponent(id));
 useOperationUpdates(api);
 const [mutationError,setError]=useState(''),[chunks,setChunks]=useState<any[]>([]),[offset,setOffset]=useState<number|null>(0),[url,setUrl]=useState('');
 const player=useRef<HTMLAudioElement>(null);
 useEffect(()=>{if(player.current)player.current.currentTime=startMs/1000;},[startMs,url]);
 const error=mutationError||(readError?errorMessage(readError):'');
 async function load(){refresh();}
 useEffect(()=>()=>{const audio=player.current;if(audio){audio.pause();audio.removeAttribute('src');audio.load();}},[]);
 async function action(fn:()=>Promise<void>){try{setError('');await fn();}catch(e){setError(errorMessage(e));}}
 if(!file)return <section className="file-detail">{loading&&<p role="status">{moteText('正在读取…')}</p>}{error&&<p role="alert" className="error-banner">{error}<button className="button" onClick={refresh}>{moteText('重新读取')}</button></p>}</section>;
 return <section className="file-detail"><h3>{file.item.title}</h3><p>{bytes(file.sizeBytes)} · {fileAvailability(file)}{file.originMissing?moteText(" · 来源已不可见，中央归档仍可使用"):''}</p>
 {file.hasOriginal&&<div className="source-toolbar"><button className="button" onClick={()=>void action(async()=>{const r=await api.request<{url:string}>('/api/files/'+id+'/playback',{method:'POST',body:'{}'});setUrl(r.url);})}>{moteText("加载原件 / 回听")}</button><button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/playback',{method:'POST',body:'{}'});const a=document.createElement('a');a.href='/api/files/'+id+'/content?download=1';a.download=file.item.title;a.click();})}>{moteText("下载原件")}</button></div>}
 {url&&file.item.mimeType?.startsWith('audio/')&&<audio onError={()=>setError(moteText("浏览器无法播放此编码，可下载原件使用本机播放器打开。"))} ref={player} controls src={url} preload="metadata" onLoadedMetadata={()=>{if(player.current)player.current.currentTime=startMs/1000;}}/>}
 <p>{moteText("转写：")}{file.job?states[file.job.state]??file.job.state:moteText("不读取内容")}{moteText("；摘要：")}{file.job?states[file.job.summary_state]??file.job.summary_state:moteText("无")}{file.job?.error&&`（${errors[file.job.error]??moteText("处理未完成")}）`}</p>
 {file.job&&<div className="source-toolbar"><button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/retry',{method:'POST',body:'{}'});await load();})}>{moteText("重新转写 / 提取")}</button>{!file.job.local_only&&<button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/retry',{method:'POST',body:JSON.stringify({stage:'summary'})});await load();})}>{moteText("重新生成摘要")}</button>}{!!file.job.local_only&&<button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/retry',{method:'POST',body:JSON.stringify({stage:'diarize'})});await load();})}>{moteText("重新分离说话人（保留转写）")}</button>}<button className="button" onClick={()=>void action(load)}>{moteText("刷新处理状态")}</button></div>}
 {file.processingPolicy&&<details className="source-item"><summary>{moteText("处理策略与匹配原因")}</summary>{file.processingPolicy.applied?<><p>{moteText("实际使用：")}{file.processingPolicy.applied.profile.name} · {file.processingPolicy.applied.profile.processorId}</p><p>{moteText("命中")}{file.processingPolicy.applied.rule.sourceId?moteText("来源覆盖"):moteText("全局类型规则")}：{file.processingPolicy.applied.rule.type}</p><p>{moteText("配置版本：")}{file.processingPolicy.applied.revision}</p><pre>{JSON.stringify(file.processingPolicy.applied.profile.parameters,null,2)}</pre></>:<p>{file.processingPolicy.legacyRevision?moteText("历史任务使用旧版配置；重处理后会记录方案。"):moteText("尚未执行内容处理。")}</p>}<p>{moteText("按当前设置重新处理将使用：")}{file.processingPolicy.current.profile.name}（{file.processingPolicy.current.rule.type}）</p></details>}
 {file.steps?.map(s=><p key={s.step}>{{extract:moteText("转写 / 提取"),diarize:moteText("说话人分离"),align:moteText("时间对齐"),turns:moteText("语义分组")}[s.step]??s.step}：{states[s.state]??s.state}{' '}{moteText("· 尝试")}{' '}{s.attempts}{' '}{moteText("次")}</p>)}
 {file.artifacts.some(a=>['transcript','text','image-text'].includes(a.kind))&&<FileReview key={id} api={api} id={id} artifacts={file.artifacts} onChanged={async()=>{await load();setChunks([]);setOffset(0);}}/>}
 {file.artifacts.filter(a=>a.kind==='summary').map(a=><div key={a.id}><h4>{moteText("模型摘要")}</h4>{a.sections?.map((s,i)=><AnswerMarkdown key={i} onOpen={onOpen} answer={{answer:s.answer,runId:a.id,trace:[],citations:s.citationIds.map(id=>({id,capturedAt:file.item.observedAt,appName:file.item.title,excerpt:''}))}}/>)}</div>)}
 {chunks.length>0&&<h4>{moteText("转写 / 提取片段")}</h4>}{chunks.map(c=><div key={c.id} className="source-item"><button className="text-button" onClick={()=>{if(player.current&&c.fileEvidence?.startMs!==undefined)player.current.currentTime=c.fileEvidence.startMs/1000;}}>{c.fileEvidence?.startMs!==undefined?moteText("{0} 秒", Math.floor(c.fileEvidence.startMs/1000)):moteText("文本片段")}</button>{(c.fileEvidence?.uncertain||c.fileEvidence?.overlap)&&<span> · {c.fileEvidence.overlap?moteText("重叠说话"):moteText("说话人不确定")}</span>}<p className="file-text">{c.ocrText}</p></div>)}
 {offset!==null&&file.job?.state==='succeeded'&&<button className="button" onClick={()=>void action(async()=>{const r=await api.request<{items:any[];nextOffset:number|null}>('/api/files/'+id+'/chunks?offset='+offset);setChunks(v=>[...v,...r.items]);setOffset(r.nextOffset);})}>{chunks.length?moteText("继续展开"):moteText("展开转写 / 原文片段")}</button>}
 {error&&<p role="alert" className="error-banner">{error}</p>}</section>;
}

function fileAvailability(file:FileRow):string {const index=file.item.document?.fileIndex;return file.hasOriginal?moteText("原件已归档"):index?.status==='pending'?moteText("索引待处理，原件留本机"):index?.coverage==='full'?moteText("全文索引就绪"):index?.coverage==='lightweight'?moteText("轻量索引就绪"):moteText("已登记目录");}
