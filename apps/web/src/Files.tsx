import {failureMessage} from './failure-message';
import {ImageProgress} from './ImageProgress';
import {formatEvidenceRef} from '@mote/shared';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {useOperationUpdates} from './useOperationUpdates';
import { moteText } from '@mote/shared/i18n';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {type Api,type Capture,bytes,dateTime,errorMessage} from './api';
import {FileReview} from './FileReview';
import {AnswerMarkdown} from './AnswerMarkdown';
import {FileProcessingControls} from './FileProcessingControls';

type FileRow={cancellation?:{canCancel:boolean;wait:'running'|'unknown'|null};processingPolicy?:{capabilities?:{dialogue:boolean;summary:boolean};applied:any;current:any};captureId:string;sourceId:string;sizeBytes:number;hasOriginal:boolean;originMissing:boolean;item:{document?:{fileIndex?:import('@mote/shared').FileIndex};text?:string;title:string;layer:string;observedAt:string;mimeType?:string};job:null|{state:string;error?:string;summary_state:string;execution?:import('@mote/shared').ExecutionEnvelope};steps?:{step:string;state:string;attempts:number;execution?:import('@mote/shared').ExecutionEnvelope}[];artifacts:{id:string;kind:string;complete?:boolean;sections?:{answer:string;citationIds:string[]}[]}[]};
const errors:Record<string,string>={snapshot_input_expired:moteText("快照的临时输入已清理，请重新同步来源文件后重试。"),archive_only:moteText("仅归档原件"),model_missing:moteText("等待安装本地模型"),processor_not_configured:moteText("处理插件或本地模型尚未配置"),not_configured:moteText("请配置中央处理服务"),unsupported_format:moteText("此格式仅归档原件"),provider_failed:moteText("转写服务未完成，请检查服务后重试"),processing_limit:moteText("超过处理大小或单文件时长限制"),summary_failed:moteText("摘要生成失败，可单独重试")};
const states:Record<string,string>={skipped:moteText("已跳过"),waiting:moteText("等待处理"),running:moteText("处理中"),succeeded:moteText("已完成"),blocked:moteText("等待配置或格式支持"),failed:moteText("处理失败"),cancelled:moteText("已取消")};

export function Files({api,onOpen}:{api:Api;onOpen:(id:string)=>void}){
 const [query,setQuery]=useState(''),[sourceId,setSourceId]=useState(''),[mimePrefix,setMimePrefix]=useState('');
 const [applied,setApplied]=useState({query:'',sourceId:'',mimePrefix:''}),[cursor,setCursor]=useState<string|null>(null),[previous,setPrevious]=useState<FileRow[]>([]);
 const path='/api/files?'+new URLSearchParams({query:applied.query,...(applied.sourceId?{sourceId:applied.sourceId}:{}),...(applied.mimePrefix?{mimePrefix:applied.mimePrefix}:{}),...(cursor?{cursor}:{})});
 const page=useResource<{items:FileRow[];nextCursor:string|null}>(api,path),sourceList=useResource<{items:{id:string;name:string;deviceId:string}[]}>(api,'/api/sources');
 useOperationUpdates(api);
 const items=[...previous,...(page.data?.items??[]).filter(item=>!previous.some(old=>old.captureId===item.captureId))],nextCursor=page.data?.nextCursor,sources=sourceList.data?.items??[],busy=page.loading;
 const error=page.error?errorMessage(page.error):sourceList.error?errorMessage(sourceList.error):'';
 function load(more=false){if(more&&nextCursor){setPrevious(items);setCursor(nextCursor);}else{setApplied({query,sourceId,mimePrefix});setPrevious([]);setCursor(null);resources(api).invalidate(key=>key.startsWith('/api/files?'));}}

 return <section><h2>{moteText("文件归档")}</h2><p>{moteText("集中浏览手机、电脑和 NAS 来源。手机删除原件后，中央已归档内容仍保留。")}</p><form className="source-toolbar" onSubmit={e=>{e.preventDefault();void load();}}><input aria-label={moteText("文件名")} placeholder={moteText("按文件名或目录查找")} value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label={moteText("文件来源")} value={sourceId} onChange={e=>setSourceId(e.target.value)}><option value="">{moteText("全部来源")}</option>{sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><select aria-label={moteText("文件格式")} value={mimePrefix} onChange={e=>setMimePrefix(e.target.value)}><option value="">{moteText("全部格式")}</option><option value="audio/">{moteText("录音")}</option><option value="text/">{moteText("文本")}</option><option value="image/">{moteText("图片")}</option></select><button className="button" disabled={busy}>{moteText("查找 / 刷新")}</button></form>{error&&<p className="error-banner" role="alert">{error}</p>}{!items.length&&!busy&&!error&&<p className="muted">{moteText("尚无匹配文件。在手机“日历与文件”中选择录音目录后，文件会出现在这里。")}</p>}<div className="source-list">{items.map(f=><button className="source-item file-card" key={f.captureId} onClick={()=>onOpen(formatEvidenceRef('capture',f.captureId))}><strong>{f.item.title}</strong><span>{bytes(f.sizeBytes)} · {fileAvailability(f)}{f.originMissing?moteText(" · 原位置已不可见"):''}</span><span>{dateTime(f.item.observedAt)} · {f.job?states[f.job.state]??f.job.state:moteText("无需内容处理")}</span></button>)}</div>{nextCursor&&<button disabled={busy} className="button" onClick={()=>void load(true)}>{moteText("继续加载")}</button>}</section>;
}

function SegmentCorrection({api,id,chunk,onSaved}:{api:Api;id:string;chunk:Capture;onSaved:()=>void}){
 const [editing,setEditing]=useState(false),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const evidence=chunk.fileEvidence;
 const prefix=evidence?.speaker?`[${evidence.speaker}] `:'';
 const originalText=prefix&&chunk.ocrText.startsWith(prefix)?chunk.ocrText.slice(prefix.length):chunk.ocrText;
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 if(!evidence)return null;
 async function save(){
  if(busy)return;setBusy(true);setError('');
  try{await api.request('/api/files/'+id+'/corrections',{method:'POST',body:JSON.stringify({artifactId:evidence!.artifactId,chunkId:chunk.id,originalText,correctedText:text})});if(alive.current){setEditing(false);onSaved();}}
  catch(error){if(alive.current)setError(errorMessage(error));}finally{if(alive.current)setBusy(false);}
 }
 return editing?<form onSubmit={event=>{event.preventDefault();void save();}}><label>{moteText("校正此段文字")}<textarea autoFocus value={text} maxLength={8000} onChange={event=>setText(event.target.value)} disabled={busy}/></label><p>{moteText("仅保存人工校正，不调用模型；原件和原始转写保留。")} </p><button className="button" type="submit" disabled={busy||!text.length}>{moteText("保存校正")}</button><button className="button" type="button" disabled={busy} onClick={()=>setEditing(false)}>{moteText("取消")}</button>{error&&<p role="alert">{error}</p>}</form>:<button className="button" onClick={()=>{setText(originalText);setError('');setEditing(true);}}>{moteText("纠正此段")}</button>;
}

export function FileDetail(props:{api:Api;id:string;startMs?:number;onOpen:(id:string)=>void}){return <FileDetailContents key={props.id} {...props}/>;}
function FileDetailContents({api,id,startMs=0,onOpen}:{api:Api;id:string;startMs?:number;onOpen:(id:string)=>void}){
 const {data:file,error:readError,loading,refresh}=useResource<FileRow>(api,'/api/files/'+encodeURIComponent(id));
 useOperationUpdates(api);
 const [mutationError,setError]=useState(''),[chunks,setChunks]=useState<Capture[]>([]),[offset,setOffset]=useState<number|null>(0),[url,setUrl]=useState('');
 const player=useRef<HTMLAudioElement>(null);
 const originalRequest=useRef<AbortController|null>(null);
 const [originalLoading,setOriginalLoading]=useState(false),[nativeSize,setNativeSize]=useState(false);
 useLayoutEffect(()=>{setUrl('');setNativeSize(false);setOriginalLoading(false);return()=>{originalRequest.current?.abort();originalRequest.current=null;};},[api]);
 async function loadOriginal(){
  if(originalRequest.current)return;const controller=new AbortController();originalRequest.current=controller;setOriginalLoading(true);setError('');
  try{const result=await api.request<{url:string}>('/api/files/'+id+'/playback',{method:'POST',body:'{}',signal:controller.signal});if(originalRequest.current===controller&&!controller.signal.aborted)setUrl(result.url);}
  catch(error){if(originalRequest.current===controller&&!controller.signal.aborted)setError(errorMessage(error));}
  finally{if(originalRequest.current===controller){originalRequest.current=null;setOriginalLoading(false);}}
 }
 const chunkRequest=useRef<AbortController|null>(null),chunkGeneration=useRef(0);
 const [chunksLoading,setChunksLoading]=useState(false);
 const textArtifact=file?.artifacts.find(a=>a.kind==='corrected-dialogue')??file?.artifacts.find(a=>a.kind==='dialogue')??file?.artifacts.find(a=>['transcript','text','image-text'].includes(a.kind));
 const rawTranscript=textArtifact?.kind==='transcript';
 const summaryDisabled=file?.processingPolicy?.capabilities?.summary===false||(file?.processingPolicy?.applied??file?.processingPolicy?.current)?.profile?.summarize===false;
 const processingError=file?.job?.error&&['failed','blocked'].includes(file.job.state);
 const summaryError=file?.job?.error&&!processingError&&!summaryDisabled&&['failed','blocked'].includes(file.job.summary_state);
 function resetChunks(){chunkGeneration.current++;chunkRequest.current?.abort();chunkRequest.current=null;setChunks([]);setOffset(0);setChunksLoading(false);}
 useLayoutEffect(()=>{resetChunks();setError('');return()=>{chunkGeneration.current++;chunkRequest.current?.abort();chunkRequest.current=null;};},[api,textArtifact?.id]);
 async function loadChunks(){
  if(chunkRequest.current||offset===null||!textArtifact)return;
  const controller=new AbortController(),generation=chunkGeneration.current;
  chunkRequest.current=controller;setChunksLoading(true);setError('');
  const current=()=>chunkGeneration.current===generation&&chunkRequest.current===controller&&!controller.signal.aborted;
  try{
   const result=await api.request<{items:Capture[];nextOffset:number|null}>('/api/files/'+id+'/chunks?offset='+offset,{signal:controller.signal});
   if(!current())return;
   if(result.items.some(item=>item.fileEvidence?.artifactId&&item.fileEvidence.artifactId!==textArtifact.id)){resetChunks();refresh();return;}
   setChunks(items=>[...items,...result.items]);setOffset(result.nextOffset);
  }catch(error){if(current())setError(errorMessage(error));}
  finally{if(current()){chunkRequest.current=null;setChunksLoading(false);}}
 }
 useEffect(()=>{if(player.current)player.current.currentTime=startMs/1000;},[startMs,url]);
 const error=mutationError||(readError?errorMessage(readError):'');
 async function load(){refresh();}
 useEffect(()=>()=>{const audio=player.current;if(audio){audio.pause();audio.removeAttribute('src');audio.load();}},[]);
 async function action(fn:()=>Promise<void>){try{setError('');await fn();}catch(e){setError(errorMessage(e));}}
 if(!file)return <section className="file-detail">{loading&&<p role="status">{moteText('正在读取…')}</p>}{error&&<p role="alert" className="error-banner">{error}<button className="button" onClick={refresh}>{moteText('重新读取')}</button></p>}</section>;
 return <section className="file-detail"><h3>{file.item.title}</h3><p>{bytes(file.sizeBytes)} · {fileAvailability(file)}{file.originMissing?moteText(" · 来源已不可见，中央归档仍可使用"):''}</p>
 {file.hasOriginal&&<div className="source-toolbar"><button className="button" disabled={originalLoading} onClick={()=>void loadOriginal()}>{originalLoading?moteText('正在读取…'):file.item.mimeType?.startsWith('image/')?moteText('查看原图'):moteText("加载原件 / 回听")}</button><button className="button" onClick={()=>void action(async()=>{await api.request('/api/files/'+id+'/playback',{method:'POST',body:'{}'});const a=document.createElement('a');a.href='/api/files/'+id+'/content?download=1';a.download=file.item.title;a.click();})}>{moteText("下载原件")}</button></div>}
 {url&&!readError&&file.item.mimeType?.startsWith('image/')&&<div className="original-image"><div className="original-image-controls"><button className="button" aria-pressed={!nativeSize} onClick={()=>setNativeSize(false)}>{moteText('适应宽度')}</button><button className="button" aria-pressed={nativeSize} onClick={()=>setNativeSize(true)}>{moteText('原始尺寸')}</button><button className="button" onClick={()=>setUrl('')}>{moteText('收起原图')}</button></div><div className={`original-image-viewport${nativeSize?' native-size':''}`} tabIndex={0} role="region" aria-label={moteText('原图，可滚动查看')}><div className="capture-image"><img src={url} alt={file.item.title} decoding="async" onError={()=>setError(moteText('影像暂不可用'))}/></div></div></div>}
 {url&&file.item.mimeType?.startsWith('audio/')&&<audio onError={()=>setError(moteText("浏览器无法播放此编码，可下载原件使用本机播放器打开。"))} ref={player} controls src={url} preload="metadata" onLoadedMetadata={()=>{if(player.current)player.current.currentTime=startMs/1000;}}/>}
 {file.job?.state==='skipped'&&file.job.error&&<p>{failureMessage(file.job.error)}</p>}
 <p>{moteText("整体处理：")}{file.job?states[file.job.state]??file.job.state:moteText("不读取内容")}{processingError&&file.job?.error&&`（${rawTranscript&&file.steps?.some(s=>s.step==='diarize'&&s.state==='failed')?moteText("说话人分离未完成，已保留原始转写。"):errors[file.job.error]??moteText("处理未完成")}）`}{moteText("；摘要：")}{summaryDisabled?moteText("未安排摘要"):file.job?states[file.job.summary_state]??file.job.summary_state:moteText("无")}{summaryError&&file.job?.error&&`（${errors[file.job.error]??moteText("处理未完成")}）`}</p>
 {file.item.mimeType?.startsWith('image/')?<ImageProgress api={api} id={id}/>:<FileProcessingControls api={api} id={id}/>}
 {file.processingPolicy&&<details className="source-item"><summary>{moteText("处理策略与匹配原因")}</summary>{file.processingPolicy.applied?<><p>{moteText("实际使用：")}{file.processingPolicy.applied.profile.name} · {file.processingPolicy.applied.profile.processorId}</p><p>{moteText("命中")}{file.processingPolicy.applied.rule.sourceId?moteText("来源覆盖"):moteText("全局类型规则")}：{file.processingPolicy.applied.rule.type}</p><p>{moteText("配置版本：")}{file.processingPolicy.applied.revision}</p><pre>{JSON.stringify(file.processingPolicy.applied.profile.parameters,null,2)}</pre></>:<p>{moteText("尚未执行内容处理。")}</p>}<p>{moteText("按当前设置重新处理将使用：")}{file.processingPolicy.current.profile.name}（{file.processingPolicy.current.rule.type}）</p></details>}
 {file.steps?.map(s=><p key={s.step}>{{extract:moteText("转写 / 提取"),diarize:moteText("说话人分离"),align:moteText("时间对齐"),turns:moteText("语义分组")}[s.step]??s.step}：{states[s.state]??s.state}{' '}{moteText("· 尝试")}{' '}{s.attempts}{' '}{moteText("次")}</p>)}
 {file.artifacts.some(a=>['transcript','text','image-text'].includes(a.kind))&&<FileReview key={id} api={api} id={id} artifacts={file.artifacts} onChanged={async()=>{resetChunks();await load();}}/>}
 {file.artifacts.filter(a=>a.kind==='summary').map(a=><div key={a.id}><h4>{moteText("模型摘要")}</h4>{a.sections?.map((s,i)=><AnswerMarkdown key={i} onOpen={onOpen} answer={{answer:s.answer,runId:a.id,trace:[],citations:s.citationIds.map(id=>({id,capturedAt:file.item.observedAt,appName:file.item.title,excerpt:''}))}}/>)}</div>)}
 {rawTranscript&&<p>{moteText("原始转写已保留，尚未校正；说话人分离与对话整理的结果另行生成。")}</p>}
 {chunks.length>0&&<h4>{rawTranscript?moteText("原始转写 · 未校正"):moteText("转写 / 提取片段")}</h4>}{chunks.map(c=><div key={c.id} className="source-item"><button className="text-button" onClick={()=>{if(player.current&&c.fileEvidence?.startMs!==undefined)player.current.currentTime=c.fileEvidence.startMs/1000;}}>{c.fileEvidence?.startMs!==undefined?moteText("{0} 秒", Math.floor(c.fileEvidence.startMs/1000)):moteText("文本片段")}</button>{c.fileEvidence?.speakerAttribution&&<span> · {moteText("已确认说话人：{0}",c.fileEvidence.speakerAttribution.name)}</span>}{(c.fileEvidence?.uncertain||c.fileEvidence?.overlap)&&<span> · {c.fileEvidence.overlap?moteText("重叠说话"):moteText("说话人不确定")}</span>}<p className="file-text">{c.ocrText}</p><SegmentCorrection key={c.fileEvidence?.artifactId+':'+c.id} api={api} id={id} chunk={c} onSaved={()=>{resetChunks();refresh();resources(api).invalidate(key=>/^\/api\/(memories|materials|conversations|capture-browser)([/?]|$)/.test(key));}}/></div>)}
 {offset!==null&&textArtifact&&<button className="button" disabled={chunksLoading} onClick={()=>void loadChunks()}>{chunks.length?moteText("继续展开"):rawTranscript?moteText("展开原始转写（未校正）"):moteText("展开转写 / 原文片段")}</button>}
 {error&&<p role="alert" className="error-banner">{error}</p>}</section>;
}

function fileAvailability(file:FileRow):string {const index=file.item.document?.fileIndex;return file.hasOriginal?moteText("原件已归档"):index?.status==='blocked'?moteText("隐私规则无法应用，输入未上传"):index?.status==='pending'?moteText("中央索引待处理，原件不归档"):index?.coverage==='full'?moteText("全文索引就绪"):index?.coverage==='lightweight'?moteText("部分索引就绪"):moteText("已登记目录");}
