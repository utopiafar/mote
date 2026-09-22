import {uploadImportFiles} from './import-upload-scheduler';
import { moteText } from '@mote/shared/i18n';
import {useEffect,useState,useRef} from 'react';
import {ArrowRight,Check,FileArchive,FileText,FolderOpen,LoaderCircle,Plus,RefreshCw,Trash2,Upload,X} from 'lucide-react';
import type {ImportJob,ImportStatus} from '@mote/shared';
import {type Api,bytes,dateTime,errorMessage} from './api';
import {ArchivedFileButton} from './ArchivedFileButton';
import {MemoryProgress,useMemoryJob} from './MemoryProgress';

export const importStatusLabels:Record<ImportStatus,string>={queued:moteText("原件已归档"),preparing:moteText("正在理解资料"),awaiting_confirmation:moteText("等待你确认"),importing:moteText("正在保存记录"),completed:moteText("记录已保存"),failed:moteText("需要重试"),needs_configuration:moteText("等待配置模型"),unsupported:moteText("原件已保留")};
const working=(job:ImportJob)=>['queued','preparing','importing'].includes(job.status);

export function Imports({api,onOpen,onMemories,onSettings,onChanged,refreshVersion=0}:{refreshVersion?:number;api:Api;onOpen:(id:string)=>void;onMemories:()=>void;onSettings:()=>void;onChanged:()=>void}){
  const uploadIds=useRef(new WeakMap<File,string>());
  const [uploadedBytes,setUploadedBytes]=useState(0);
  const [items,setItems]=useState<ImportJob[]>([]),[selected,setSelected]=useState('');
  const [creating,setCreating]=useState(true),[mode,setMode]=useState<'files'|'directory'>('files');
  const [files,setFiles]=useState<File[]>([]),[directory,setDirectory]=useState(''),[name,setName]=useState(''),[instruction,setInstruction]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true),[dragging,setDragging]=useState(false);
  const [deleteConfirm,setDeleteConfirm]=useState('');
  const active=items.find(item=>item.id===selected);
  const {job:memoryJob,error:memoryError,reload:reloadMemory}=useMemoryJob(api,active?.memoryJobId);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function load(){
      try{
        const result=await api.request<{items:ImportJob[]}>('/api/imports',{signal:controller.signal});
        if(controller.signal.aborted)return;
        setItems(result.items);setLoading(false);
        if(result.items.some(working))timer=setTimeout(()=>void load(),2000);
      }catch(e){if(!controller.signal.aborted){setError(errorMessage(e));setLoading(false);timer=setTimeout(()=>void load(),8000);}}
    }
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[api,revision,refreshVersion]);
  function addFiles(next:File[]){
    const total=[...files,...next];
    if(total.length>2000){setError(moteText("一次最多选择 2,000 个文件。较多文件可以打包为 ZIP 或使用服务器目录。"));return;}
    if(next.some(file=>file.size>64*1024*1024)){setError(moteText("单个上传文件不能超过 64 MB，请拆分文件后导入。"));return;}
    if(total.reduce((sum,file)=>sum+file.size,0)>256*1024*1024){setError(moteText("一次上传的文件总量不能超过 256 MB，请分批导入。"));return;}
    setFiles(total);setError('');
  }
  function update(job:ImportJob){setItems(current=>[job,...current.filter(item=>item.id!==job.id)]);setSelected(job.id);setCreating(false);setRevision(v=>v+1);}
  async function create(){
    setBusy(true);setError('');
    try{
      const archivedFileIds=mode==='files'?await uploadImportFiles(api,files,uploadIds.current,setUploadedBytes):[];
      const payload={name:name.trim()||undefined,instruction,processing:instruction.trim()?'preview':'automatic',...(mode==='files'?{archivedFileIds}:{directory:directory.trim()})};
      const job=await api.request<ImportJob>('/api/imports',{method:'POST',body:JSON.stringify(payload)});
      update(job);setFiles([]);setName('');setInstruction('');setDirectory('');onChanged();
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function action(path:string,body?:unknown){
    setBusy(true);setError('');
    try{update(await api.request<ImportJob>(path,{method:'POST',...(body?{body:JSON.stringify(body)}:{})}));onChanged();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function retryMemory(){if(!memoryJob)return;setBusy(true);setError('');try{await api.request('/api/memory-jobs/'+encodeURIComponent(memoryJob.id)+'/retry',{method:'POST'});reloadMemory();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  async function remove(){
    if(!active||deleteConfirm!==active.id)return;
    setBusy(true);setError('');
    try{await api.raw('/api/imports/'+encodeURIComponent(active.id),{method:'DELETE'});setItems(current=>current.filter(item=>item.id!==active.id));setSelected('');setCreating(true);setDeleteConfirm('');setRevision(value=>value+1);onChanged();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  return <section className="imports-page">
    <div className="page-heading split-heading"><div><div className="eyebrow">{moteText("让已有资料成为可用的上下文")}</div><h1>{moteText("导入")}</h1><p>{moteText("上传文件即可保存原件。普通文本直接收录；需要解释人物和结构的资料先预览再确认。")}</p></div><button className="button primary" onClick={()=>{setCreating(true);setSelected('');setError('');}}><Plus size={16}/>{moteText("新建导入")}</button></div>
    {error&&<div className="error-banner" role="alert">{error}<button className="text-button" onClick={()=>setRevision(v=>v+1)}>{moteText("刷新状态")}</button></div>}
    <div className="workspace-layout">
      <aside className="workspace-list" aria-label={moteText("导入历史")}><div className="workspace-list-heading"><h2>{moteText("导入记录")}</h2><button className="icon-button" aria-label={moteText("刷新导入记录")} onClick={()=>setRevision(v=>v+1)}><RefreshCw size={15}/></button></div>{loading&&<p className="muted">{moteText("正在读取…")}</p>}{!loading&&!items.length&&<p className="muted">{moteText("你的第一份导入会保留在这里，随时查看进度与原件。")}</p>}{items.map(job=><button key={job.id} className={'workspace-select '+(!creating&&selected===job.id?'active':'')} onClick={()=>{setSelected(job.id);setCreating(false);setError('');}}><strong>{job.name}</strong><span className={'status-label '+(job.status==='failed'?'attention':'')}>{working(job)&&<LoaderCircle size={12} className="spin"/>}{importStatusLabels[job.status]}</span><small>{dateTime(job.createdAt)} · {job.archive.files}{' '}{moteText("个文件")}</small></button>)}</aside>
      <div className="workspace-content">
      {creating?<form className="panel import-form" onSubmit={e=>{e.preventDefault();void create();}}>
        <div className="section-heading"><div><h2>{moteText("添加一份资料")}</h2><p>{moteText("支持多个文件、ZIP 压缩包，或中央服务器上的目录。")}</p></div></div>
        <nav className="segmented-nav" aria-label={moteText("导入方式")}><button type="button" className={mode==='files'?'active':''} onClick={()=>setMode('files')}><Upload size={15}/>{moteText("选择文件")}</button><button type="button" className={mode==='directory'?'active':''} onClick={()=>setMode('directory')}><FolderOpen size={15}/>{moteText("服务器目录")}</button></nav>
        {mode==='files'?<><label className={'file-drop '+(dragging?'dragging':'')} onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);addFiles(Array.from(e.dataTransfer.files));}}><FileArchive size={30}/><strong>{moteText("选择文件，或拖到这里")}</strong><span>{moteText("聊天导出、文档、笔记与附件可以一起提交")}</span><input type="file" multiple aria-label={moteText("选择导入文件")} disabled={busy} onChange={e=>{addFiles(Array.from(e.target.files??[]));e.target.value='';}}/></label>{files.length>0&&<div className="selected-files"><div className="source-toolbar"><strong>{moteText("已选")}{' '}{files.length}{' '}{moteText("个文件")}</strong><span className="muted">{bytes(files.reduce((sum,file)=>sum+file.size,0))}</span><button type="button" className="text-button" disabled={busy} onClick={()=>setFiles([])}>{moteText("清空")}</button></div>{files.map((file,index)=><div key={index} className="file-row"><FileText size={15}/><span>{file.name}</span><small>{bytes(file.size)}</small><button type="button" className="icon-button" disabled={busy} aria-label={moteText("移除 ")+file.name} onClick={()=>setFiles(value=>value.filter((_,i)=>i!==index))}><X size={14}/></button></div>)}</div>}</>:<label className="field-label">{moteText("中央服务器上的目录")}<input value={directory} onChange={e=>setDirectory(e.target.value)} placeholder="/data/imports/my-notes" required maxLength={4000}/><small>{moteText("这是运行 Mote 中央节点的机器上的路径。节点会复制可读取的文件到归档。")}</small></label>}
        <label className="field-label">{moteText("资料名称")}{' '}<span className="muted">{moteText("选填")}</span><input value={name} onChange={e=>setName(e.target.value)} placeholder={moteText("例如：过去一年的随手记")} maxLength={200}/></label>
        <label className="field-label">{moteText("告诉 Mote 如何理解这份资料")}<textarea value={instruction} onChange={e=>setInstruction(e.target.value)} rows={4} maxLength={12000} placeholder={moteText("例如：这是我的聊天导出，张三是我。时间是北京时间；每段对话独立保存，保留消息的时间和附件关系。")}/><small>{moteText("可以说明人物、时间、格式和需要保留的细节。含糊之处会出现在预览中。")}</small></label>
        <div className="form-footer">{busy&&mode==='files'&&<label aria-live="polite">{bytes(uploadedBytes)} / {bytes(files.reduce((n,f)=>n+f.size,0))}<progress aria-label={moteText("文件上传进度")} value={uploadedBytes} max={files.reduce((n,f)=>n+f.size,0)||1}/></label>}<span className="muted">{moteText("先保存原件，解析完成后由你确认。")}</span><button className="button primary" disabled={busy||(mode==='files'?!files.length:!directory.trim())}>{busy?<LoaderCircle size={15} className="spin"/>:<ArrowRight size={15}/>} {busy?moteText("正在上传并保存原件…"):moteText("保存原件并处理")}</button></div>
      </form>:active?<article className="panel import-detail">
        <div className="section-heading"><div><div className="eyebrow">{importStatusLabels[active.status]}</div><h2>{active.name}</h2><p>{dateTime(active.createdAt)} · {active.archive.files}{' '}{moteText("个原件 ·")}{' '}{bytes(active.archive.bytes)}</p></div></div>
        <ol className="import-steps" aria-label={moteText("导入流程")}><li className="done"><Check size={14}/>{moteText("保留原件")}</li><li className={active.preview?'done':''}>{moteText("2 理解与预览")}</li><li className={active.status==='completed'?'done':''}>{moteText("3 保存记录")}</li><li className={memoryJob?.status==='completed'?'done':''}>{moteText("4 提取候选记忆")}</li></ol>
        {working(active)&&<div className="workflow-line" role="status"><LoaderCircle size={20} className="spin"/><div><strong>{importStatusLabels[active.status]}</strong><p>{active.status==='importing'?moteText("已处理 {0} / {1} 条记录", active.progress.processed, active.progress.total):moteText("原始文件已保存。Mote 正在读取样例并理解结构，可以离开此页面，稍后回来查看。")}</p></div></div>}
        {active.status==='importing'&&active.progress.total>0&&<progress aria-label={moteText("记录保存进度")} max={active.progress.total} value={active.progress.processed}/>}
        {active.summary&&<p className="import-summary">{active.summary}</p>}
        {active.warnings.length>0&&<div className="review-notes"><h3>{moteText("请留意这些信息")}</h3><ul>{active.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}
        {active.dispositions&&<details className="import-dispositions" open={active.dispositions.counts.unsupported>0||active.dispositions.counts.excluded>0}><summary>{moteText("文件解析情况 ·")}{' '}{active.dispositions.counts.parsed}{' '}{moteText("个已解析")}{active.dispositions.counts.attachment>0?moteText(" · {0} 个作为附件", active.dispositions.counts.attachment):''}{active.dispositions.counts.unsupported>0?moteText(" · {0} 个暂不支持", active.dispositions.counts.unsupported):''}{active.dispositions.counts.excluded>0?moteText(" · {0} 个未纳入", active.dispositions.counts.excluded):''}</summary><p className="muted">{moteText("所有原件仍被保留，只有解析出的记录会进入后续记忆提取。")}</p>{active.dispositions.items.map(file=><div className="disposition-row" key={file.fileId}><strong>{file.path}</strong><span>{({parsed:moteText("已解析"),attachment:moteText("附件"),container:moteText("压缩包"),excluded:moteText("未纳入"),unsupported:moteText("暂不支持")})[file.status]}</span><p>{file.reason}</p></div>)}</details>}
        {active.error&&<div className="error-banner" role="alert">{active.error}</div>}
        {active.status==='needs_configuration'&&<div className="workflow-line"><div><strong>{moteText("原件已归档，等待配置模型")}</strong><p>{moteText("配置后即可继续生成解析预览。")}</p><button className="button" onClick={onSettings}>{moteText("打开模型设置")}</button></div></div>}
        {active.status==='unsupported'&&<p className="muted">{moteText("这次未能提取可用记录，原件已保留。你可以补充格式说明后重新分析。")}</p>}
        {active.preview&&<section className="import-preview"><div className="section-heading"><div><h3>{moteText("解析预览")}</h3><p>{moteText("预计")}{' '}{active.preview.count}{' '}{moteText("条记录 · 以下是内容样例")}</p></div></div>{active.preview.samples.map((sample,index)=><article className="preview-sample" key={index}><strong>{sample.title||moteText("未命名记录")}</strong><p>{sample.text}</p>{sample.attachmentCount>0&&<small>{sample.attachmentCount}{' '}{moteText("个关联附件")}</small>}</article>)}</section>}
        {['awaiting_confirmation','needs_configuration','failed','unsupported'].includes(active.status)&&<ImportInstructions key={active.id} instruction={active.instruction} busy={busy} onPrepare={value=>void action('/api/imports/'+encodeURIComponent(active.id)+'/prepare',{instruction:value})}/>}
        {active.status==='awaiting_confirmation'&&<div className="confirm-import"><div><strong>{moteText("确认这份资料的理解方式")}</strong><p>{moteText("确认后保存记录，并在后台分批提取有证据的候选记忆。")}</p></div><button className="button primary" disabled={busy} onClick={()=>void action('/api/imports/'+encodeURIComponent(active.id)+'/confirm')}><Check size={16}/>{moteText("确认并开始导入")}</button></div>}
        {active.status==='failed'&&<button className="button" disabled={busy} onClick={()=>void action('/api/imports/'+encodeURIComponent(active.id)+'/retry')}><RefreshCw size={15}/>{moteText("重试导入")}</button>}
        {active.status==='completed'&&<div className="workflow-line"><span className="workflow-icon done"><Check size={18}/></span><div><strong>{moteText("记录已保存到中央归档")}</strong><p>{active.progress.imported}{' '}{moteText("条新记录 ·")}{' '}{active.progress.duplicates}{' '}{moteText("条重复记录")}{!active.memoryJobId?moteText("；尚未安排记忆整理。"):''}</p></div></div>}
        {memoryJob&&<MemoryProgress job={memoryJob} onRetry={()=>void retryMemory()} onView={onMemories} busy={busy}/>}{memoryError&&<p className="error-banner" role="alert">{moteText("记忆进度暂时无法更新：")}{memoryError}</p>}
        {active.status==='completed'&&!active.memoryJobId&&<button className="button" onClick={onMemories}>{moteText("前往记忆")}</button>}
        <details className="import-originals"><summary>{moteText("已保留的原件（")}{active.files.length}）</summary>{active.files.map(file=><div key={file.id} className="file-row"><FileText size={15}/><div><strong>{file.relativePath||file.name}</strong><small>{bytes(file.sizeBytes)}</small></div><ArchivedFileButton api={api} id={file.id} name={file.name}/></div>)}</details>
        {active.captureIds.length>0&&<details className="import-originals"><summary>{moteText("已归档的记录（")}{active.captureIds.length}）</summary><div className="evidence-buttons">{active.captureIds.map((id,index)=><button className="button subtle" key={id} onClick={()=>onOpen(id)}>{moteText("查看记录")}{' '}{index+1}</button>)}</div></details>}
        <div className="import-delete">{deleteConfirm===active.id?<><p>{moteText("删除这次导入及不再使用的资料、原件和依赖记忆？其他导入或证据仍引用的共享资料与原件会保留。此操作无法撤销。")}</p><div className="source-toolbar"><button className="button danger" disabled={busy||working(active)} onClick={()=>void remove()}>{moteText("确认删除整次导入")}</button><button className="button subtle" disabled={busy} onClick={()=>setDeleteConfirm('')}>{moteText("取消")}</button></div></>:<button className="text-button danger-text" disabled={busy||working(active)} onClick={()=>setDeleteConfirm(active.id)}><Trash2 size={13}/>{moteText("删除这次导入")}</button>}</div>
      </article>:<div className="panel workspace-empty"><FolderOpen size={30}/><h2>{moteText("选择一次导入，查看它的来处与进度。")}</h2><button className="button" onClick={()=>setCreating(true)}>{moteText("添加资料")}</button></div>}
      </div>
    </div>
  </section>;
}
function ImportInstructions({instruction,busy,onPrepare}:{instruction:string;busy:boolean;onPrepare:(value:string)=>void}){
  const [value,setValue]=useState(instruction);
  return <details className="import-instructions"><summary>{moteText("补充说明，重新理解资料")}</summary><label className="field-label">{moteText("这份资料应该如何理解")}<textarea rows={4} maxLength={12000} value={value} onChange={e=>setValue(e.target.value)}/></label><button className="button" disabled={busy} onClick={()=>onPrepare(value)}>{moteText("重新生成预览")}</button></details>;
}
