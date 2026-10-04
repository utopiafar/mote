import {importQueue,validateImportFiles,type ImportQueueEntry} from './import-queue';
import {readImportDrop} from './import-drop';
import {ImportQueueRow,ImportQueueDetail} from './ImportQueueEntry';
import { moteText } from '@mote/shared/i18n';
import React,{useEffect,useState,useRef,useSyncExternalStore} from 'react';
import {Check,FileArchive,FileText,FolderOpen,LoaderCircle,Plus,RefreshCw,Trash2,Upload,X} from 'lucide-react';
import type {ImportJob,ImportStatus} from '@mote/shared';
import {ApiError,type Api,bytes,dateTime,errorMessage} from './api';
import {ArchivedFileButton} from './ArchivedFileButton';
import {MemoryProgress,useMemoryJob} from './MemoryProgress';
import {useResource} from './useResource';

export const importStatusLabels:Record<ImportStatus,string>={queued:moteText("原件已归档"),preparing:moteText("正在理解资料"),awaiting_confirmation:moteText("等待你确认"),importing:moteText("正在保存记录"),completed:moteText("记录已保存"),failed:moteText("需要重试"),cancelled:moteText("已取消"),needs_configuration:moteText("等待配置模型"),unsupported:moteText("原件已保留")};
const intakeWorking=(job:ImportJob)=>['queued','preparing','importing'].includes(job.status);
const working=(job:ImportJob)=>intakeWorking(job)||Boolean(job.media?.some(item=>['waiting','running'].includes(item.processing?.state??'')||['waiting','running'].includes(item.memory?.state??'')));
const label=(job:ImportJob)=>job.status==='completed'&&job.media?.length?moteText('媒体已接入'):importStatusLabels[job.status];
const mediaStates:Record<string,string>={waiting:moteText('等待内容提取'),running:moteText('正在提取内容'),succeeded:moteText('内容提取完成'),failed:moteText('内容提取失败'),blocked:moteText('等待配置或处理条件'),cancelled:moteText('已取消')};
const memoryStates:Record<string,string>={waiting:moteText('等待记忆整理'),waiting_for_model:moteText('等待配置或处理条件'),paused:moteText('已暂停'),cancelled:moteText('已取消'),running:moteText('记忆整理中'),completed:moteText('记忆整理完成'),failed:moteText('记忆整理失败'),disabled:moteText('未启用自动记忆')};

export function Imports({api,onOpen,onMemories,onSettings,onChanged,refreshVersion=0}:{refreshVersion?:number;api:Api;onOpen:(id:string)=>void;onMemories:()=>void;onSettings:()=>void;onChanged:()=>void}){
  const queue=importQueue(api);
  const queueState=useSyncExternalStore(queue.subscribe,queue.getSnapshot,queue.getSnapshot);
  const queueVersion=useRef(queueState.completedVersion);
  const [loadError,setLoadError]=useState('');
  const [items,setItems]=useState<ImportJob[]>([]),[selected,setSelected]=useState('');
  const [creating,setCreating]=useState(true),[mode,setMode]=useState<'files'|'directory'>('files');
  const [files,setFiles]=useState<File[]>([]),[directory,setDirectory]=useState(''),[name,setName]=useState(''),[instruction,setInstruction]=useState('');
  const [sourcePackId,setSourcePackId]=useState('');
  const sourcePacks=useResource<{items:{id:string;version:string;description?:string}[]}>(api,'/api/import-source-packs');
  const [pending,setPending]=useState<Set<string>>(new Set()),[error,setError]=useState(''),[loading,setLoading]=useState(true),[dragging,setDragging]=useState(false);
  const [readingFiles,setReadingFiles]=useState(false);
  const fileRead=useRef<AbortController|null>(null);
  const [deleteConfirm,setDeleteConfirm]=useState('');
  const [confirmError,setConfirmError]=useState<{jobId:string;message:string}|null>(null);
  const confirmGeneration=useRef(0);
  const localEntry=queueState.entries.find(item=>item.id===selected);
  const active=items.find(item=>item.id===selected)||localEntry?.job;
  const busy=Boolean(active&&pending.has(active.id));
  const [actionErrors,setActionErrors]=useState<Record<string,string>>({});
  const pendingJobs=useRef(new Set<string>());
  const selectedRef=useRef(selected);selectedRef.current=selected;
  const scope=useRef(new AbortController());
  const {job:memoryJob,error:memoryError,reload:reloadMemory}=useMemoryJob(api,active?.memoryJobId);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{const controller=new AbortController();scope.current=controller;return()=>controller.abort();},[api]);
  useEffect(()=>{confirmGeneration.current++;setConfirmError(null);},[api,selected]);
  useEffect(()=>{fileRead.current?.abort();fileRead.current=null;setReadingFiles(false);setItems([]);setSelected('');setCreating(true);setLoadError('');setError('');setPending(new Set());setActionErrors({});setFiles([]);setName('');setInstruction('');setSourcePackId('');setDirectory('');pendingJobs.current=new Set();queueVersion.current=0;},[api]);
  useEffect(()=>{
    if(queueVersion.current===queueState.completedVersion)return;
    queueVersion.current=queueState.completedVersion;
    const jobs=queueState.entries.flatMap(entry=>entry.job?[entry.job]:[]);
    setItems(current=>[...jobs,...current.filter(item=>!jobs.some(job=>job.id===item.id))]);
    setSelected(current=>queueState.entries.find(entry=>entry.id===current)?.job?.id??current);
    setRevision(value=>value+1);
  },[queueState,queue]);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    setLoading(true);
    async function load(){
      try{
        const result=await api.request<{items:ImportJob[]}>('/api/imports',{signal:controller.signal});
        if(controller.signal.aborted)return;
        const submitted=queue.getSnapshot().entries.flatMap(entry=>entry.job?[entry.job]:[]);
        const merged=[...submitted.filter(job=>!result.items.some(item=>item.id===job.id)),...result.items];
        setItems(merged);queue.acknowledge(result.items.map(item=>item.id));setLoadError('');setLoading(false);
        if(merged.some(working))timer=setTimeout(()=>void load(),2000);
      }catch(e){if(!controller.signal.aborted){setLoadError(errorMessage(e));setLoading(false);if(e instanceof ApiError&&[401,403].includes(e.status)){setItems([]);setSelected('');}else timer=setTimeout(()=>void load(),8000);}}
    }
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[api,queue,revision,refreshVersion]);
  function addFiles(next:File[]){
    const total=[...files,...next],failure=validateImportFiles(total);
    if(failure){setError(failure);return;}
    setFiles(total);setError('');
  }
  async function addDrop(data:DataTransfer){
    if(fileRead.current)return;
    const controller=new AbortController(),owner=scope.current.signal;fileRead.current=controller;setReadingFiles(true);setError('');
    try{const next=await readImportDrop(data,AbortSignal.any([controller.signal,owner]));if(!owner.aborted&&!controller.signal.aborted)addFiles(next);}
    catch(error){if(!owner.aborted&&!controller.signal.aborted)setError(errorMessage(error));}
    finally{if(fileRead.current===controller){fileRead.current=null;if(!owner.aborted)setReadingFiles(false);}}
  }
  function update(job:ImportJob){setItems(current=>[job,...current.filter(item=>item.id!==job.id)]);setRevision(v=>v+1);}
  function create(){
    if(readingFiles||(mode==='files'?!files.length:!directory.trim()))return;
    try{queue.enqueue({source:mode==='files'?{kind:'files',files}:{kind:'directory',path:directory},name,instruction,sourcePackId});setFiles([]);setName('');setInstruction('');setSourcePackId('');setDirectory('');setError('');}
    catch(error){setError(errorMessage(error));}
  }
  function editEntry(entry:ImportQueueEntry){
    const draft=queue.draft(entry.id);if(!draft)return;
    fileRead.current?.abort();fileRead.current=null;setReadingFiles(false);
    queue.discard(entry.id);setMode(draft.source.kind);setFiles([]);setDirectory(draft.source.kind==='directory'?draft.source.path:'');setName(draft.name);setInstruction(draft.instruction);setSourcePackId(draft.sourcePackId);setCreating(true);setSelected('');setError('');
  }
  async function mutate(id:string,work:(signal:AbortSignal)=>Promise<ImportJob|void>,confirmJobId?:string,success?:()=>void){
    const jobs=pendingJobs.current;if(jobs.has(id))return;
    const signal=scope.current.signal,generation=++confirmGeneration.current;
    const current=()=>!signal.aborted&&pendingJobs.current===jobs;
    jobs.add(id);setPending(new Set(jobs));setActionErrors(errors=>({...errors,[id]:''}));setConfirmError(null);
    try{const job=await work(signal);if(current()){if(job)update(job);success?.();onChanged();}}
    catch(error){if(!current())return;const message=error instanceof ApiError&&error.code==='import_stopping'?moteText('上一次处理仍在结束，请稍后再点击重试。'):error instanceof ApiError&&error.code==='import_finishing'?moteText('解析正在收尾，请稍后再确认。'):errorMessage(error);if(confirmJobId){if(generation===confirmGeneration.current)setConfirmError({jobId:confirmJobId,message});}else setActionErrors(errors=>({...errors,[id]:message}));}
    finally{if(current()){jobs.delete(id);setPending(new Set(jobs));}}
  }
  function action(path:string,body?:unknown,confirmJobId?:string){if(!active)return;void mutate(active.id,signal=>api.request<ImportJob>(path,{method:'POST',...(body?{body:JSON.stringify(body)}:{}),signal}),confirmJobId);}
  function controlMedia(captureId:string,operation:'retry'|'cancel'){
    if(!active)return;const id=active.id;
    void mutate(id,async signal=>{await api.request('/api/files/'+encodeURIComponent('capture:'+captureId)+'/'+operation,{method:'POST',body:'{}',signal});signal.throwIfAborted();return api.request<ImportJob>('/api/imports/'+encodeURIComponent(id),{signal});});
  }
  function controlMemory(action:'retry'|'pause'|'resume'|'cancel'){if(!memoryJob||!active)return;void mutate(active.id,async signal=>{await api.request('/api/memory-jobs/'+encodeURIComponent(memoryJob.id)+'/'+action,{method:'POST',signal});},undefined,reloadMemory);}
  function remove(){
    if(!active||deleteConfirm!==active.id)return;const id=active.id;
    void mutate(id,async signal=>{await api.raw('/api/imports/'+encodeURIComponent(id),{method:'DELETE',signal});},undefined,()=>{setItems(current=>current.filter(item=>item.id!==id));if(selectedRef.current===id){setSelected('');setCreating(true);}setDeleteConfirm(current=>current===id?'':current);setRevision(value=>value+1);});
  }
  return <section className="imports-page">
    <div className="page-heading split-heading"><div><div className="eyebrow">{moteText("让已有资料成为可用的上下文")}</div><h1>{moteText("导入")}</h1><p>{moteText("上传后保留原件。解析结果明确可靠且无歧义时自动保存，否则先预览并确认。")}</p></div><button className="button primary" onClick={()=>{setCreating(true);setSelected('');setError('');}}><Plus size={16}/>{moteText("新建导入")}</button></div>
    {loadError&&<div className="error-banner" role="alert">{loadError}<button className="text-button" onClick={()=>setRevision(v=>v+1)}>{moteText("刷新状态")}</button></div>}
    <div className="workspace-layout">
      <aside className="workspace-list import-queue-list" aria-label={moteText("导入队列")}>
        <div className="workspace-list-heading"><h2>{moteText("导入队列")}</h2><button className="icon-button" aria-label={moteText("刷新导入记录")} onClick={()=>setRevision(v=>v+1)}><RefreshCw size={15}/></button></div>
        <p className="import-queue-hint">{moteText('可连续添加资料，每份资料独立处理。')}</p>
        {queueState.entries.filter(entry=>entry.state!=='submitted').map(entry=><ImportQueueRow key={entry.id} entry={entry} queue={queue} selected={!creating&&selected===entry.id} onSelect={()=>{setSelected(entry.id);setCreating(false);setError('');}} onEdit={editEntry}/>)}
        {loading&&<p className="muted">{moteText("正在读取…")}</p>}
        {!loading&&!loadError&&!items.length&&!queueState.entries.length&&<p className="muted">{moteText("你的第一份导入会保留在这里，随时查看进度与原件。")}</p>}
        {items.length>0&&<h3 className="import-history-heading">{moteText('已归档的导入')}</h3>}
        {items.map(job=><button key={job.id} className={'workspace-select '+(!creating&&selected===job.id?'active':'')} onClick={()=>{setSelected(job.id);setCreating(false);setError('');}}><strong>{job.name}</strong><span className={'status-label '+(['failed','awaiting_confirmation','needs_configuration'].includes(job.status)?'attention':'')}>{working(job)&&<LoaderCircle size={12} className="spin"/>}{label(job)}</span><small>{dateTime(job.createdAt)} · {job.archive.files}{' '}{moteText("个文件")}</small></button>)}
      </aside>
      <div className="workspace-content">
      {creating?<form className="panel import-form" onSubmit={e=>{e.preventDefault();void create();}}>
        <div className="section-heading"><div><h2>{moteText("添加一份资料")}</h2><p>{moteText("支持多个文件、ZIP 压缩包，或中央服务器上的目录。")}</p></div></div>
        <nav className="segmented-nav" aria-label={moteText("导入方式")}><button type="button" className={mode==='files'?'active':''} onClick={()=>setMode('files')}><Upload size={15}/>{moteText("选择文件")}</button><button type="button" className={mode==='directory'?'active':''} onClick={()=>setMode('directory')}><FolderOpen size={15}/>{moteText("服务器目录")}</button></nav>
        {mode==='files'?<><label className={'file-drop '+(dragging?'dragging':'')} onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);void addDrop(e.dataTransfer);}}><FileArchive size={30}/><strong>{moteText("选择文件，或将文件和文件夹拖到这里")}</strong><span>{moteText("聊天导出、文档、笔记与附件可以一起提交")}</span><input type="file" multiple disabled={readingFiles} aria-label={moteText("选择导入文件")} onChange={e=>{addFiles(Array.from(e.target.files??[]));e.target.value='';}}/></label><label className="button secondary import-folder-picker"><FolderOpen size={15}/>{moteText("选择文件夹…")}<input type="file" multiple {...{webkitdirectory:''}} disabled={readingFiles} aria-label={moteText("选择文件夹…")} onChange={e=>{addFiles(Array.from(e.target.files??[]));e.target.value='';}}/></label>{readingFiles&&<p role="status">{moteText("正在读取所选文件…")}</p>}{files.length>0&&<div className="selected-files"><div className="source-toolbar"><strong>{moteText("已选")}{' '}{files.length}{' '}{moteText("个文件")}</strong><span className="muted">{bytes(files.reduce((sum,file)=>sum+file.size,0))}</span><button type="button" className="text-button" disabled={readingFiles} onClick={()=>setFiles([])}>{moteText("清空")}</button></div>{files.map((file,index)=><div key={index} className="file-row"><FileText size={15}/><span>{file.webkitRelativePath||file.name}</span><small>{bytes(file.size)}</small><button type="button" className="icon-button" disabled={readingFiles} aria-label={moteText("移除 ")+(file.webkitRelativePath||file.name)} onClick={()=>setFiles(value=>value.filter((_,i)=>i!==index))}><X size={14}/></button></div>)}</div>}</>:<label className="field-label">{moteText("中央服务器上的目录")}<input value={directory} onChange={e=>setDirectory(e.target.value)} placeholder="/data/imports/my-notes" required maxLength={4000}/><small>{moteText("这是运行 Mote 中央节点的机器上的路径。节点会复制可读取的文件到归档。")}</small></label>}
        <label className="field-label">{moteText("资料名称")}{' '}<span className="muted">{moteText("选填")}</span><input value={name} onChange={e=>setName(e.target.value)} placeholder={moteText("例如：过去一年的随手记")} maxLength={200}/></label>
        {Boolean(sourcePacks.data?.items?.length)&&<label className="field-label">{moteText("解析方式")}<select value={sourcePackId} onChange={event=>{setSourcePackId(event.target.value);if(event.target.value)setInstruction('');}}><option value="">{moteText("默认格式处理或模型解析")}</option>{sourcePacks.data!.items.map(pack=><option key={pack.id} value={pack.id}>{pack.description||pack.id} · {pack.version}</option>)}</select><small>{moteText("本地 Source Pack 使用已固定的解析程序；不接受临时解析说明。")}</small></label>}
        <label className="field-label">{moteText("告诉 Mote 如何理解这份资料")}<textarea disabled={Boolean(sourcePackId)} value={instruction} onChange={e=>setInstruction(e.target.value)} rows={4} maxLength={12000} placeholder={moteText("例如：这是我的聊天导出，张三是我。时间是北京时间；每段对话独立保存，保留消息的时间和附件关系。")}/><small>{moteText("可以说明人物、时间、格式和需要保留的细节。含糊之处会出现在预览中。")}</small></label>
        {error&&<div className="error-banner" role="alert">{error}</div>}
        <div className="form-footer"><span className="muted">{moteText("明确可靠且无歧义的解析结果会自动保存；其余需要你确认。")}</span><button className="button primary" disabled={readingFiles||(mode==='files'?!files.length:!directory.trim())}><Plus size={15}/>{moteText("加入导入队列")}</button></div>
        <p className="import-session-hint">{moteText('切换页面后队列继续运行。未上传完的本地文件需保持当前浏览器会话。')}</p>
      </form>:active?<article className="panel import-detail">
        <div className="section-heading"><div><div className="eyebrow">{label(active)}</div><h2>{active.name}</h2><p>{dateTime(active.createdAt)} · {active.archive.files}{' '}{moteText("个原件 ·")}{' '}{bytes(active.archive.bytes)}</p></div></div>
        <ol className="import-steps" aria-label={moteText("导入流程")}><li className="done"><Check size={14}/>{moteText("保留原件")}</li><li className={active.preview?'done':''}>{moteText("2 理解与预览")}</li><li className={active.status==='completed'?'done':''}>{moteText("3 保存记录")}</li><li className={memoryJob?.status==='completed'||(active.media?.length&&active.media.every(item=>item.memory?.state==='completed'))?'done':''}>{moteText("4 提取记忆")}</li></ol>
        {intakeWorking(active)&&<div className="workflow-line" role="status"><LoaderCircle size={20} className="spin"/><div><strong>{label(active)}</strong><p>{active.status==='importing'?moteText("已处理 {0} / {1} 条记录", active.progress.processed, active.progress.total):moteText("原始文件已保存。Mote 正在读取样例并理解结构，可以离开此页面，稍后回来查看。")}</p></div></div>}
        {active.status==='importing'&&active.progress.total>0&&<progress aria-label={moteText("记录保存进度")} max={active.progress.total} value={active.progress.processed}/>}
        {active.summary&&<p className="import-summary">{active.summary}</p>}
        {active.reviewGate&&<p className="notice">{active.reviewGate.decision==='automatic'?moteText("自动发布"):moteText("需要确认")}{' · '}{active.reviewGate.reason}</p>}
        {active.warnings.length>0&&<div className="review-notes"><h3>{moteText("请留意这些信息")}</h3><ul>{active.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}
        {active.dispositions&&<details className="import-dispositions" open={active.dispositions.counts.unsupported>0||active.dispositions.counts.excluded>0}><summary>{moteText("文件解析情况 ·")}{' '}{active.dispositions.counts.parsed}{' '}{moteText("个已解析")}{active.dispositions.counts.processing?moteText(' · {0} 个进入文件处理',active.dispositions.counts.processing):''}{active.dispositions.counts.attachment>0?moteText(" · {0} 个作为附件", active.dispositions.counts.attachment):''}{active.dispositions.counts.unsupported>0?moteText(" · {0} 个暂不支持", active.dispositions.counts.unsupported):''}{active.dispositions.counts.excluded>0?moteText(" · {0} 个未纳入", active.dispositions.counts.excluded):''}</summary><p className="muted">{moteText('媒体原件按文件处理设置提取内容；记忆整理等待所需内容就绪。')}</p>{active.dispositions.items.map(file=><div className="disposition-row" key={file.fileId}><strong>{file.path}</strong><span>{({parsed:moteText("已解析"),attachment:moteText("附件"),container:moteText("压缩包"),excluded:moteText("未纳入"),unsupported:moteText("暂不支持"),processing:moteText('文件管线')})[file.status]}</span><p>{file.reason}</p></div>)}</details>}
        {intakeWorking(active)&&<button className="button" disabled={busy} onClick={()=>void action('/api/imports/'+encodeURIComponent(active.id)+'/cancel')}>{moteText('取消处理')}</button>}
        {active.status==='cancelled'&&<p role="status">{moteText('处理已取消，已归档的原件和记录仍保留。点击重试继续处理。')}</p>}
        {actionErrors[active.id]&&<div className="error-banner" role="alert">{actionErrors[active.id]}</div>}
        {active.error&&<div className="error-banner" role="alert">{active.error}</div>}
        {active.status==='needs_configuration'&&<div className="workflow-line"><div><strong>{moteText("原件已归档，等待配置模型")}</strong><p>{moteText("配置后即可继续生成解析预览。")}</p><button className="button" onClick={onSettings}>{moteText("打开模型设置")}</button></div></div>}
        {active.status==='unsupported'&&<p className="muted">{moteText("这次未能提取可用记录，原件已保留。你可以补充格式说明后重新分析。")}</p>}
        {active.preview&&<section className="import-preview"><div className="section-heading"><div><h3>{moteText("解析预览")}</h3><p>{active.media?.length?moteText('{0} 条文本记录，{1} 个媒体原件将进入文件处理',active.preview.count-active.media.length,active.media.length):<>{moteText("预计")}{' '}{active.preview.count}{' '}{moteText("条记录 · 以下是内容样例")}</>}</p></div></div>{active.preview.samples.map((sample,index)=><article className="preview-sample" key={index}><strong>{sample.title||moteText("未命名记录")}</strong><p>{sample.text}</p>{sample.attachmentCount>0&&<small>{sample.attachmentCount}{' '}{moteText("个关联附件")}</small>}</article>)}</section>}
        {['awaiting_confirmation','needs_configuration','failed','unsupported'].includes(active.status)&&<ImportInstructions key={active.id} instruction={active.instruction} busy={busy} onPrepare={value=>void action('/api/imports/'+encodeURIComponent(active.id)+'/prepare',{instruction:value})}/>}
        {active.status==='awaiting_confirmation'&&<div className="confirm-import"><div><strong>{moteText("确认这份资料的理解方式")}</strong><p>{moteText("确认后保存记录；记忆整理按自动设置执行，也可稍后手动发起。")}</p></div>{confirmError?.jobId===active.id&&<div className="error-banner" role="alert">{confirmError.message}</div>}<button className="button primary" disabled={busy} onClick={()=>void action('/api/imports/'+encodeURIComponent(active.id)+'/confirm',undefined,active.id)}><Check size={16}/>{moteText("确认并开始导入")}</button></div>}
        {(active.status==='failed'||active.status==='cancelled'||active.status==='unsupported')&&<button className="button" disabled={busy} onClick={()=>void action('/api/imports/'+encodeURIComponent(active.id)+'/retry')}><RefreshCw size={15}/>{moteText("重试导入")}</button>}
        {active.status==='completed'&&!active.media?.length&&<div className="workflow-line"><span className="workflow-icon done"><Check size={18}/></span><div><strong>{moteText("记录已保存到中央归档")}</strong><p>{active.progress.imported}{' '}{moteText("条新记录 ·")}{' '}{active.progress.duplicates}{' '}{moteText("条重复记录")}{!active.memoryJobId?moteText("；尚未安排记忆整理。"):''}</p></div></div>}
        {Boolean(active.media?.length)&&<section className="import-originals"><h3>{moteText('媒体处理进度')}</h3><p className="muted">{moteText('已接入不等于已可搜索。内容提取、搜索和记忆整理分别显示状态。')}</p>{active.media!.map(item=><article className="preview-sample" key={item.fileId}>
          <strong>{active.files.find(file=>file.id===item.fileId)?.relativePath}</strong><p>{mediaStates[item.processing?.state??'']??moteText('原件已归档')} · {item.searchable?moteText('已有可搜索片段'):moteText('尚无可搜索片段')} · {memoryStates[item.memory?.state??'']??moteText('等待内容就绪')}</p>
          {item.processing?.error&&<p role="status">{item.processing.error}</p>}
          {item.captureId&&<div className="source-toolbar"><button className="button subtle" onClick={()=>onOpen(item.captureId!)}>{moteText('查看记录')}</button>{['failed','blocked','cancelled'].includes(item.processing?.state??'')&&<button className="button" disabled={busy} onClick={()=>void controlMedia(item.captureId!,'retry')}>{moteText('重试处理')}</button>}{['waiting','running'].includes(item.processing?.state??'')&&<button className="button subtle" disabled={busy} onClick={()=>void controlMedia(item.captureId!,'cancel')}>{moteText('取消处理')}</button>}</div>}
        </article>)}</section>}
        {memoryJob&&<MemoryProgress job={memoryJob} onRetry={()=>void controlMemory('retry')} onAction={action=>void controlMemory(action)} onView={onMemories} busy={busy}/>}{memoryError&&<p className="error-banner" role="alert">{moteText("记忆进度暂时无法更新：")}{memoryError}</p>}
        {active.status==='completed'&&!active.memoryJobId&&<button className="button" onClick={onMemories}>{moteText("前往记忆")}</button>}
        <details className="import-originals"><summary>{moteText("已保留的原件（")}{active.files.length}）</summary>{active.files.map(file=><div key={file.id} className="file-row"><FileText size={15}/><div><strong>{file.relativePath||file.name}</strong><small>{bytes(file.sizeBytes)}</small></div><ArchivedFileButton api={api} id={file.id} name={file.name}/></div>)}</details>
        {active.captureIds.length>0&&<details className="import-originals"><summary>{moteText("已归档的记录（")}{active.captureIds.length}）</summary><div className="evidence-buttons">{active.captureIds.map((id,index)=><button className="button subtle" key={id} onClick={()=>onOpen(id)}>{moteText("查看记录")}{' '}{index+1}</button>)}</div></details>}
        <div className="import-delete">{deleteConfirm===active.id?<><p>{moteText("删除这次导入及不再使用的资料、原件和依赖记忆？其他导入或证据仍引用的共享资料与原件会保留。此操作无法撤销。")}</p><div className="source-toolbar"><button className="button danger" disabled={busy||intakeWorking(active)} onClick={()=>void remove()}>{moteText("确认删除整次导入")}</button><button className="button subtle" disabled={busy} onClick={()=>setDeleteConfirm('')}>{moteText("取消")}</button></div></>:<button className="text-button danger-text" disabled={busy||intakeWorking(active)} onClick={()=>setDeleteConfirm(active.id)}><Trash2 size={13}/>{moteText("删除这次导入")}</button>}</div>
      </article>:localEntry?<ImportQueueDetail entry={localEntry} queue={queue} onEdit={editEntry}/>:<div className="panel workspace-empty"><FolderOpen size={30}/><h2>{moteText("选择一次导入，查看它的来处与进度。")}</h2><button className="button" onClick={()=>setCreating(true)}>{moteText("添加资料")}</button></div>}
      </div>
    </div>
  </section>;
}
function ImportInstructions({instruction,busy,onPrepare}:{instruction:string;busy:boolean;onPrepare:(value:string)=>void}){
  const [value,setValue]=useState(instruction);
  return <details className="import-instructions"><summary>{moteText("补充说明，重新理解资料")}</summary><label className="field-label">{moteText("这份资料应该如何理解")}<textarea disabled={busy} rows={4} maxLength={12000} value={value} onChange={e=>setValue(e.target.value)}/></label><button className="button" disabled={busy} onClick={()=>onPrepare(value)}>{moteText("重新生成预览")}</button></details>;
}
