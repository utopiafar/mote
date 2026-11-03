import {importReviewMessage,importHostDiagnostics} from '../../import-messages';
import {ArchivedFileReader} from '../reader';
import {ImportInstructions} from '../../ImportInstructions';
import {formatEvidenceRef,commonFailureMessage,httpStatusMessage} from '@mote/shared';
import {importQueue,validateImportFiles,type ImportQueueEntry} from './import-queue';
import {readImportDrop} from '../../import-drop';
import {ImportQueueRow,ImportQueueDetail} from './ImportQueueEntry';
import { moteText } from '@mote/shared/i18n';
import React,{useContext,useEffect,useLayoutEffect,useState,useRef,useSyncExternalStore} from 'react';
import {Check,ChevronRight,FileArchive,FileText,FolderOpen,LoaderCircle,Plus,RefreshCw,Trash2,X} from 'lucide-react';
import type {ArchivedFile,ImportJob,ImportStatus} from '@mote/shared';
import {ApiError,type Api,type Capture,bytes,dateTime,errorMessage} from '../../api';
import {ArchivedFileButton} from '../../ArchivedFileButton';
import {MemoryProgress,useMemoryJob} from '../memory/MemoryProgress';
import {useResource} from '../../useResource';
import {FileProcessingControls} from '../../FileProcessingControls';
import {confirmNavigation,useUnsavedChanges} from '../../unsaved';
import {ImportNavigationContext} from '../../import-navigation';

const importFailure=(error:unknown)=>error instanceof ApiError?commonFailureMessage(error.code??'',error.status)||httpStatusMessage(error.status):errorMessage(error);
export const importStatusLabels:Record<ImportStatus,string>={queued:moteText("原件已归档"),preparing:moteText("正在理解资料"),awaiting_confirmation:moteText("等待你确认"),importing:moteText("正在保存记录"),completed:moteText("记录已保存"),failed:moteText("需要重试"),cancelled:moteText("已取消"),needs_configuration:moteText("等待配置模型"),unsupported:moteText("原件已保留")};
const needsAction=(job:ImportJob)=>['failed','awaiting_confirmation','needs_configuration','unsupported'].includes(job.status);
const intakeWorking=(job:ImportJob)=>['queued','preparing','importing'].includes(job.status);
const working=(job:ImportJob)=>intakeWorking(job)||Boolean(job.memoryProgress&&(job.memoryProgress.pending+job.memoryProgress.running>0))||Boolean(job.media?.some(item=>['waiting','running'].includes(item.processing?.state??'')||['waiting','running'].includes(item.memory?.state??'')));
const label=(job:ImportJob)=>job.status==='completed'&&job.media?.length?moteText('媒体已接入'):importStatusLabels[job.status];
const mediaStates:Record<string,string>={waiting:moteText('等待内容提取'),running:moteText('正在提取内容'),succeeded:moteText('内容提取完成'),failed:moteText('内容提取失败'),blocked:moteText('等待配置或处理条件'),cancelled:moteText('已取消')};
const memoryStates:Record<string,string>={waiting:moteText('等待记忆整理'),waiting_for_model:moteText('等待配置或处理条件'),paused:moteText('已暂停'),cancelled:moteText('已取消'),running:moteText('记忆整理中'),completed:moteText('记忆整理完成'),failed:moteText('记忆整理失败'),disabled:moteText('未启用自动记忆')};

export function Imports({api,onOpen,onMemories,onSettings,onChanged,refreshVersion=0,initialJobId}:{refreshVersion?:number;api:Api;onOpen:(id:string)=>void;onMemories:()=>void;onSettings:()=>void;onChanged:()=>void;initialJobId?:string}){
  const navigation=useContext(ImportNavigationContext);
  const queue=importQueue(api);
  const queueState=useSyncExternalStore(queue.subscribe,queue.getSnapshot,queue.getSnapshot);
  const queueVersion=useRef(queueState.completedVersion);
  const [loadError,setLoadError]=useState('');
  const loadedApi=useRef<Api|null>(null);
  const [items,setItems]=useState<ImportJob[]>([]),[selected,setSelected]=useState(initialJobId??'');
  const [creating,setCreating]=useState(false);
  const [original,setOriginal]=useState<{owner:Api;jobId:string;file:ArchivedFile;opener:HTMLElement|null}|null>(null);
  const originalReturn=useRef<HTMLElement|null>(null);
  const fileCaptures=useRef<{owner:Api;jobId:string;resolved:Set<string>;files:Map<string,Set<string>>}>({owner:api,jobId:'',resolved:new Set(),files:new Map()});
  useLayoutEffect(()=>{if(!original&&originalReturn.current){originalReturn.current.isConnected&&originalReturn.current.focus({preventScroll:true});originalReturn.current=null;}},[original]);
  const [listFilter,setListFilter]=useState('all');
  const listPosition=useRef<{scroll:number;opener:HTMLElement|null}|undefined>(undefined);
  const rememberList=()=>{if(!creating&&!selected)listPosition.current={scroll:window.scrollY,opener:document.activeElement as HTMLElement|null};};
  useLayoutEffect(()=>{if(creating||selected){if(window.scrollY)window.scrollTo({top:0});return;}const position=listPosition.current;if(position){listPosition.current=undefined;position.opener?.isConnected&&position.opener.focus({preventScroll:true});if(window.scrollY!==position.scroll)window.scrollTo({top:position.scroll});}},[creating,selected]);
  const [files,setFiles]=useState<File[]>([]),[name,setName]=useState(''),[instruction,setInstruction]=useState('');
  const [sourcePackId,setSourcePackId]=useState(''),[imageProfileId,setImageProfileId]=useState('');
  const imagePlans=useResource<{policy:{profiles:import('@mote/shared').ProcessingProfile[]};processors:{id:string;stage:string;mediaTypes:string[]}[]}>(api,'/api/file-processing');
  const sourcePacks=useResource<{items:{id:string;version:string;description?:string}[]}>(api,'/api/import-source-packs');
  const [pending,setPending]=useState<Set<string>>(new Set()),[error,setError]=useState(''),[loading,setLoading]=useState(true),[dragging,setDragging]=useState(false);
  const [readingFiles,setReadingFiles]=useState(false);
  const fileRead=useRef<AbortController|null>(null);
  const [deleteConfirm,setDeleteConfirm]=useState('');
  const [confirmError,setConfirmError]=useState<{jobId:string;message:string}|null>(null);
  const confirmGeneration=useRef(0);
  const localEntry=queueState.entries.find(item=>item.id===selected);
  const ownedItems=loadedApi.current===api?items:[];
  const active=ownedItems.find(item=>item.id===selected)||localEntry?.job;
  const busy=Boolean(active&&pending.has(active.id));
  const [instructionDrafts,setInstructionDrafts]=useState<{owner:Api;values:Record<string,string>}>({owner:api,values:{}});
  const instructionDraftRef=useRef(instructionDrafts);
  const instructionValue=active&&instructionDrafts.owner===api&&Object.hasOwn(instructionDrafts.values,active.id)?instructionDrafts.values[active.id]:active?.instruction??'';
  const hostDiagnostics=active?importHostDiagnostics(active):[];
  const instructionsDirty=Boolean(active&&instructionValue!==active.instruction);
  const anyInstructionDirty=instructionDrafts.owner===api&&Object.entries(instructionDrafts.values).some(([id,value])=>{const job=ownedItems.find(item=>item.id===id);return job?value!==job.instruction:true;});
  useUnsavedChanges(Boolean(readingFiles||files.length||name||instruction||sourcePackId||imageProfileId||anyInstructionDirty));
  function editInstruction(id:string,value:string){const next={owner:api,values:{...(instructionDraftRef.current.owner===api?instructionDraftRef.current.values:{}),[id]:value}};instructionDraftRef.current=next;setInstructionDrafts(next);confirmGeneration.current++;setConfirmError(null);}
  function confirmImport(){if(!active||busy)return;const drafts=instructionDraftRef.current;if(drafts.owner===api&&Object.hasOwn(drafts.values,active.id)&&drafts.values[active.id]!==active.instruction)return;action('/api/imports/'+encodeURIComponent(active.id)+'/confirm',undefined,active.id);}
  const [actionErrors,setActionErrors]=useState<Record<string,string>>({});
  const pendingJobs=useRef(new Set<string>());
  const selectedRef=useRef(selected);selectedRef.current=selected;
  const scope=useRef(new AbortController());
  const {job:memoryJob,error:memoryError,reload:reloadMemory}=useMemoryJob(api,active?.memoryJobId);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{const controller=new AbortController();scope.current=controller;return()=>controller.abort();},[api]);
  useEffect(()=>{confirmGeneration.current++;setConfirmError(null);},[api,selected]);
  useEffect(()=>{fileRead.current?.abort();fileRead.current=null;loadedApi.current=null;setReadingFiles(false);setOriginal(null);originalReturn.current=null;const drafts={owner:api,values:{}};instructionDraftRef.current=drafts;setInstructionDrafts(drafts);setItems([]);setSelected('');setCreating(false);setListFilter('all');listPosition.current=undefined;setLoadError('');setError('');setPending(new Set());setActionErrors({});setFiles([]);setName('');setInstruction('');setSourcePackId('');setImageProfileId('');pendingJobs.current=new Set();queueVersion.current=0;},[api]);
  useEffect(()=>{if(initialJobId){setSelected(initialJobId);setCreating(false);}},[api,initialJobId]);
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
    setLoading(loadedApi.current!==api);
    async function load(){
      try{
        const result=await api.request<{items:ImportJob[]}>('/api/imports',{signal:controller.signal});
        if(controller.signal.aborted)return;
        const submitted=queue.getSnapshot().entries.flatMap(entry=>entry.job?[entry.job]:[]);
        const merged=[...submitted.filter(job=>!result.items.some(item=>item.id===job.id)),...result.items];
        loadedApi.current=api;setItems(merged);queue.acknowledge(result.items.map(item=>item.id));setLoadError('');setLoading(false);
        if(merged.some(working))timer=setTimeout(()=>void load(),2000);
      }catch(e){if(!controller.signal.aborted){setLoadError(importFailure(e));setLoading(false);if(e instanceof ApiError&&([401,403].includes(e.status)||initialJobId&&[404,410].includes(e.status))){loadedApi.current=null;setItems([]);setSelected(initialJobId??'');}else timer=setTimeout(()=>void load(),8000);}}
    }
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[api,queue,revision,refreshVersion,initialJobId]);
  function addFiles(next:File[]){
    const total=[...files,...next],failure=validateImportFiles(total);
    if(failure){setError(failure);return;}
    setFiles(total);setError('');
  }
  async function addDrop(data:DataTransfer){
    if(fileRead.current)return;
    const controller=new AbortController(),owner=scope.current.signal;fileRead.current=controller;setReadingFiles(true);setError('');
    try{const next=await readImportDrop(data,AbortSignal.any([controller.signal,owner]));if(!owner.aborted&&!controller.signal.aborted)addFiles(next);}
    catch(error){if(!owner.aborted&&!controller.signal.aborted)setError(importFailure(error));}
    finally{if(fileRead.current===controller){fileRead.current=null;if(!owner.aborted)setReadingFiles(false);}}
  }
  function update(job:ImportJob){setItems(current=>[job,...current.filter(item=>item.id!==job.id)]);setRevision(v=>v+1);}
  function create(){
    if(readingFiles||!files.length)return;
    try{const id=queue.enqueue({source:{kind:'files',files},name,instruction,sourcePackId,imageProfileId});setFiles([]);setName('');setInstruction('');setSourcePackId('');setImageProfileId('');setError('');setSelected(id);setCreating(false);}
    catch(error){setError(importFailure(error));}
  }
  function editEntry(entry:ImportQueueEntry){
    const draft=queue.draft(entry.id);if(!draft||draft.source.kind!=='files')return;
    if((readingFiles||files.length||name||instruction||sourcePackId||imageProfileId)&&!confirmNavigation())return;
    fileRead.current?.abort();fileRead.current=null;setReadingFiles(false);
    queue.discard(entry.id);setFiles([]);setName(draft.name);setInstruction(draft.instruction);setSourcePackId(draft.sourcePackId);setImageProfileId(draft.imageProfileId??'');setCreating(true);setSelected('');setError('');
  }
  async function mutate(id:string,work:(signal:AbortSignal)=>Promise<ImportJob|void>,confirmJobId?:string,success?:()=>void){
    const jobs=pendingJobs.current;if(jobs.has(id))return;
    const signal=scope.current.signal,generation=++confirmGeneration.current;
    const current=()=>!signal.aborted&&pendingJobs.current===jobs;
    jobs.add(id);setPending(new Set(jobs));setActionErrors(errors=>({...errors,[id]:''}));setConfirmError(null);
    try{const job=await work(signal);if(current()){if(job)update(job);success?.();onChanged();}}
    catch(error){if(!current())return;const message=error instanceof ApiError&&error.code==='import_stopping'?moteText('上一次处理仍在结束，请稍后再点击重试。'):error instanceof ApiError&&error.code==='import_finishing'?moteText('解析正在收尾，请稍后再确认。'):importFailure(error);if(confirmJobId){if(generation===confirmGeneration.current)setConfirmError({jobId:confirmJobId,message});}else setActionErrors(errors=>({...errors,[id]:message}));}
    finally{if(current()){jobs.delete(id);setPending(new Set(jobs));}}
  }
  function action(path:string,body?:unknown,confirmJobId?:string){if(!active)return;void mutate(active.id,signal=>api.request<ImportJob>(path,{method:'POST',...(body?{body:JSON.stringify(body)}:{}),signal}),confirmJobId);}
  function controlMemory(action:'retry'|'pause'|'resume'|'cancel'){if(!memoryJob||!active)return;void mutate(active.id,async signal=>{await api.request('/api/memory-jobs/'+encodeURIComponent(memoryJob.id)+'/'+action,{method:'POST',signal});},undefined,reloadMemory);}
  function remove(){
    if(!active||deleteConfirm!==active.id)return;const id=active.id;
    void mutate(id,async signal=>{await api.raw('/api/imports/'+encodeURIComponent(id),{method:'DELETE',signal});},undefined,()=>{setItems(current=>current.filter(item=>item.id!==id));if(selectedRef.current===id){setSelected('');setCreating(false);}setDeleteConfirm(current=>current===id?'':current);setRevision(value=>value+1);});
  }
  function recordOriginal(jobId:string,record:Capture){
    if(loadedApi.current!==api||selectedRef.current!==jobId)return;let index=fileCaptures.current;if(index.owner!==api||index.jobId!==jobId)fileCaptures.current=index={owner:api,jobId,resolved:new Set(),files:new Map()};index.resolved.add(record.id);const fileId=record.provenance?.document?.fileId;if(fileId){const ids=index.files.get(fileId)??new Set<string>();ids.add(record.id);index.files.set(fileId,ids);}
  }
  function openOriginal(file:ArchivedFile){
    if(!active)return;const media=active.media?.find(item=>item.fileId===file.id&&item.captureId);if(media?.captureId){onOpen(formatEvidenceRef('capture',media.captureId));return;}
    const index=fileCaptures.current,ids=index.owner===api&&index.jobId===active.id&&index.resolved.size===active.captureIds.length?index.files.get(file.id):undefined;if(ids?.size===1){onOpen(formatEvidenceRef('capture',[...ids][0]));return;}
    setOriginal({owner:api,jobId:active.id,file,opener:document.activeElement instanceof HTMLElement?document.activeElement:null});
  }
  return <section className={"imports-page final-imports"+(creating?" import-creating":selected?" import-selected":"")} aria-busy={loading}>
    {original?.owner===api&&<ArchivedFileReader key={original.file.id} api={api} file={original.file} onBack={()=>{originalReturn.current=original.opener;setOriginal(null);}}/>}
    <div className="imports-surface" hidden={original?.owner===api}>
    {(creating||selected)?<button className="text-button import-list-back" aria-label={moteText('返回导入列表')} onClick={()=>{setCreating(false);setSelected('');}}>← {moteText('导入资料')}</button>:navigation&&<button className="text-button import-list-back" onClick={navigation.leave}>← {moteText(navigation.label)}</button>}
    <div className="page-heading split-heading"><div><div className="eyebrow">{moteText("让已有资料成为可用的上下文")}</div><h1>{moteText(creating?"添加资料":selected?"导入详情":"导入资料")}</h1><p>{moteText("上传后保留原件。解析结果明确可靠且无歧义时自动保存，否则先预览并确认。")}</p></div><button className="button" onClick={()=>{rememberList();setCreating(true);setSelected('');setError('');}}><Plus size={16}/>{moteText("添加资料")}</button></div>
    {loadError&&<div className="error-banner" role="alert">{loadError}<button className="text-button" onClick={()=>setRevision(v=>v+1)}>{moteText("刷新状态")}</button></div>}
    {!creating&&!selected&&<nav className="import-status-tabs" aria-label={moteText("导入状态")}>{[['all',moteText("全部")],['attention',moteText("需处理")],['completed',moteText("已完成")]].map(([value,label])=><button key={value} aria-pressed={listFilter===value} onClick={()=>setListFilter(value)}>{label} {ownedItems.filter(job=>value==='all'||value==='completed'&&job.status==='completed'||value==='attention'&&needsAction(job)).length}</button>)}<button className="icon-button import-refresh" aria-label={moteText('刷新导入记录')} onClick={()=>setRevision(v=>v+1)}><RefreshCw size={15}/></button></nav>}
    <div className="workspace-layout">
      <aside className="workspace-list import-queue-list" aria-label={moteText("导入队列")}>
        <div className="workspace-list-heading"><h2>{moteText("导入队列")}</h2></div>
        <p className="import-queue-hint">{moteText('可连续添加资料，每份资料独立处理。')}</p>
        {queueState.entries.filter(entry=>entry.state!=='submitted').map(entry=><ImportQueueRow key={entry.id} entry={entry} queue={queue} selected={!creating&&selected===entry.id} onSelect={()=>{rememberList();setSelected(entry.id);setCreating(false);setError('');}} onEdit={editEntry}/>)}
        {loading&&<p className="muted">{moteText("正在读取…")}</p>}
        {!loading&&!loadError&&!ownedItems.length&&!queueState.entries.length&&<p className="muted">{moteText("你的第一份导入会保留在这里，随时查看进度与原件。")}</p>}
        {ownedItems.length>0&&<h3 className="import-history-heading">{moteText('已归档的导入')}</h3>}
        {ownedItems.filter(job=>listFilter==='all'||listFilter==='completed'&&job.status==='completed'||listFilter==='attention'&&needsAction(job)).map(job=><button key={job.id} className={'workspace-select import-job-row '+(!creating&&selected===job.id?'active':'')} onClick={()=>{rememberList();setSelected(job.id);setCreating(false);setError('');}}><span className="import-job-icon" aria-hidden="true"><FileArchive size={20}/></span><span className="import-job-copy"><strong>{job.name}</strong><small>{dateTime(job.createdAt)} · {job.archive.files} {moteText('个原件 ·')} {bytes(job.archive.bytes)}</small></span><span className={'import-job-state '+(needsAction(job)?'attention':job.status==='completed'?'success':'')}>{working(job)&&<LoaderCircle size={12} className="spin"/>}{label(job)}</span><ChevronRight className="chevron" size={15} aria-hidden="true"/></button>)}
      </aside>
      <div className="workspace-content">
      {creating?<form className="panel import-form" onSubmit={e=>{e.preventDefault();void create();}}>
        <div className={'file-drop '+(dragging?'dragging':'')} onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={e=>{e.preventDefault();setDragging(false);void addDrop(e.dataTransfer);}}><span className="import-drop-symbol" aria-hidden="true">↥</span><strong>{moteText('将文件拖到这里')}</strong><div className="import-picker-actions"><label className="button">{moteText('选择文件')}<input type="file" multiple disabled={readingFiles} aria-label={moteText('选择导入文件')} onChange={e=>{addFiles(Array.from(e.target.files??[]));e.target.value='';}}/></label><label className="text-button import-folder-picker">{moteText('选择文件夹…')}<input type="file" multiple {...{webkitdirectory:''}} disabled={readingFiles} aria-label={moteText('选择文件夹…')} onChange={e=>{addFiles(Array.from(e.target.files??[]));e.target.value='';}}/></label></div><small>{moteText('文档、聊天导出、ZIP 和媒体文件')}</small></div>
        {readingFiles&&<p role="status">{moteText('正在读取所选文件…')}</p>}{files.length>0&&<div className="selected-files"><div className="source-toolbar"><strong>{files.length}{' '}{moteText('个文件')}</strong><span className="muted">{bytes(files.reduce((sum,file)=>sum+file.size,0))}</span><button type="button" className="text-button" disabled={readingFiles} onClick={()=>setFiles([])}>{moteText('清空')}</button></div>{files.map((file,index)=><div key={index} className="file-row"><FileText size={15}/><span>{file.webkitRelativePath||file.name}</span><small>{bytes(file.size)}</small><button type="button" className="icon-button" disabled={readingFiles} aria-label={moteText('移除 ')+(file.webkitRelativePath||file.name)} onClick={()=>setFiles(value=>value.filter((_,i)=>i!==index))}><X size={14}/></button></div>)}</div>}
        <label className="field-label"><span className="import-field-label">{moteText('资料名称')}<small>{moteText('（选填）')}</small></span><input value={name} onChange={e=>setName(e.target.value)} placeholder={moteText('默认使用文件或文件夹名称')} maxLength={200}/></label>
        <label className="field-label"><span className="import-field-label">{moteText('资料说明')}<small>{moteText('（选填）')}</small></span><textarea value={instruction} onChange={e=>setInstruction(e.target.value)} rows={3} maxLength={12000} placeholder={moteText('可说明作者、时间、资料格式，以及哪些内容属于你。')}/></label>
        <details className="import-create-advanced"><summary>{moteText('更多选项')}</summary><div className="import-create-options"><label>{moteText('本次图片处理')}<select value={imageProfileId} onChange={e=>setImageProfileId(e.target.value)}><option value="">{moteText('跟随默认设置')}</option><option value="archive">{moteText('仅保存原件')}</option>{imagePlans.data?.policy?.profiles.filter(p=>p.processorId!=='archive'&&(p.imageRecipe||imagePlans.data?.processors?.some(x=>x.id===p.processorId&&x.stage==='extract'&&x.mediaTypes.some(t=>t==='image/'||t==='image/*'||t.startsWith('image/'))))).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {Boolean(sourcePacks.data?.items?.length)&&<label className="import-parser-field">{moteText('解析方式')}<select value={sourcePackId} onChange={event=>setSourcePackId(event.target.value)}><option value="">{moteText('默认格式处理或模型解析')}</option>{sourcePacks.data!.items.map(pack=><option key={pack.id} value={pack.id}>{pack.description||pack.id} · {pack.version}</option>)}</select><small className="import-parser-selection">{sourcePackId?(()=>{const pack=sourcePacks.data!.items.find(pack=>pack.id===sourcePackId);return pack?`${pack.description||pack.id} · ${pack.version}`:sourcePackId;})():moteText('默认格式处理或模型解析')}</small><small>{moteText('格式按所选 Source Pack 解析；说明用于资料背景和归属范围。')}</small></label>}</div><p>{moteText('图片默认使用中央图片方案，原件保存后自动处理。')}</p><p>{moteText('可一次说明格式、时间、作者，以及哪些内容属于你。模型按说明范围理解，第三方和 AI 引用保留原角色。')}</p><p>{moteText('未填写也会保留原件，可检索已提取的正文；身份未知时，可保存有用的来源限定观察。')}</p><p>{moteText('明确可靠且无歧义的解析结果会自动保存；其余需要你确认。')}</p><p>{moteText('切换页面后队列继续运行。未上传完的本地文件需保持当前浏览器会话。')}</p></details>
        {error&&<div className="error-banner" role="alert">{error}</div>}
        <div className="form-footer"><span className="muted">{moteText('上传完成前请保持当前浏览器打开。')}</span><button className="button primary" disabled={readingFiles||!files.length}>{moteText('加入导入队列')}</button></div>
      </form>:active?<article className="panel import-detail">
        <div className="import-detail-heading"><div className="import-current-status">{label(active)}</div><h1>{active.name}</h1><p className="import-detail-meta">{dateTime(active.createdAt)} · {active.archive.files}{' '}{moteText("个原件 ·")}{' '}{bytes(active.archive.bytes)}</p></div><div className="import-detail-body">
        <div className="import-stage-strip" aria-label={moteText('导入流程')}><div className="import-stage done"><strong><span className="import-stage-symbol">✓</span>{moteText('原件归档')}</strong><small>{active.archive.files} {moteText('个原件已保留')}</small></div><div className={'import-stage '+(active.preview||active.status==='completed'?'done':active.status==='preparing'?'current':'')}><strong><span className="import-stage-symbol">{active.preview||active.status==='completed'?'✓':'2'}</span>{moteText('理解资料')}</strong><small>{active.status==='completed'?moteText('已完成'):active.status==='awaiting_confirmation'?moteText('预览待确认'):label(active)}</small></div><div className={'import-stage '+(active.status==='completed'?'done':active.status==='importing'?'current':'')}><strong><span className="import-stage-symbol">{active.status==='completed'?'✓':'3'}</span>{moteText('保存记录')}</strong><small>{active.status==='completed'?moteText('{0} 条记录已保存',active.captureIds.length):active.status==='importing'?moteText('正在保存'):moteText('尚未保存')}</small></div></div>
        {intakeWorking(active)&&<div className="workflow-line" role="status"><LoaderCircle size={20} className="spin"/><div><strong>{label(active)}</strong><p>{active.status==='importing'?moteText("已处理 {0} / {1} 条记录", active.progress.processed, active.progress.total):moteText("原始文件已保存。Mote 正在读取样例并理解结构，可以离开此页面，稍后回来查看。")}</p></div></div>}
        {active.status==='importing'&&active.progress.total>0&&<progress aria-label={moteText("记录保存进度")} max={active.progress.total} value={active.progress.processed}/>}
        {active.reviewGate&&active.status!=='completed'&&<p className="notice">{active.reviewGate.decision==='automatic'?moteText("自动发布"):moteText("需要确认")}{' · '}{importReviewMessage(active)}</p>}
        {active.warnings.length>0&&<div className="review-notes"><h3>{moteText("请留意这些信息")}</h3><ul>{active.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></div>}
        {active.dispositions&&<details className="import-dispositions" open={active.dispositions.counts.unsupported>0||active.dispositions.counts.excluded>0}><summary>{moteText("文件解析情况 ·")}{' '}{active.dispositions.counts.parsed}{' '}{moteText("个已解析")}{active.dispositions.counts.processing?moteText(' · {0} 个进入文件处理',active.dispositions.counts.processing):''}{active.dispositions.counts.attachment>0?moteText(" · {0} 个作为附件", active.dispositions.counts.attachment):''}{active.dispositions.counts.unsupported>0?moteText(" · {0} 个暂不支持", active.dispositions.counts.unsupported):''}{active.dispositions.counts.excluded>0?moteText(" · {0} 个未纳入", active.dispositions.counts.excluded):''}</summary><p className="muted">{moteText('媒体原件按文件处理设置提取内容；记忆整理等待所需内容就绪。')}</p>{active.dispositions.items.map(file=><div className="disposition-row" key={file.fileId}><strong>{file.path}</strong><span>{({parsed:moteText("已解析"),attachment:moteText("附件"),container:moteText("压缩包"),excluded:moteText("未纳入"),unsupported:moteText("暂不支持"),processing:moteText('文件管线')})[file.status]}</span><p>{file.reason}</p></div>)}</details>}
        {intakeWorking(active)&&<button className="button" disabled={busy} onClick={()=>void action('/api/imports/'+encodeURIComponent(active.id)+'/cancel')}>{moteText('取消处理')}</button>}
        {active.status==='cancelled'&&<p role="status">{moteText('处理已取消，已归档的原件和记录仍保留。点击重试继续处理。')}</p>}
        {actionErrors[active.id]&&<div className="error-banner" role="alert">{actionErrors[active.id]}</div>}
        {active.error&&(active.status==='unsupported'?<details className="import-support-preview"><summary>{moteText('运行详情')}</summary><p>{active.error}</p></details>:<div className="error-banner" role="alert">{active.error}</div>)}
        {active.status==='needs_configuration'&&<div className="workflow-line"><div><strong>{moteText("原件已归档，等待配置模型")}</strong><p>{moteText("配置后即可继续生成解析预览。")}</p><button className="button" onClick={onSettings}>{moteText("打开模型设置")}</button></div></div>}
        {active.status==='unsupported'&&<p className="muted">{moteText("这次未能提取可用记录，原件已保留。你可以补充格式说明后重新分析。")}</p>}
        {active.preview&&active.status!=='completed'&&<section className="import-preview"><div className="section-heading"><div><h3>{moteText("解析预览")}</h3><p>{active.media?.length?moteText('{0} 条文本记录，{1} 个媒体原件将进入文件处理',active.preview.count-active.media.length,active.media.length):<>{moteText("预计")}{' '}{active.preview.count}{' '}{moteText("条记录 · 以下是内容样例")}</>}</p></div></div>{active.preview.samples.map((sample,index)=><article className="preview-sample" key={index}><strong>{sample.title||moteText("未命名记录")}</strong><p>{sample.text}</p>{sample.attachmentCount>0&&<small>{sample.attachmentCount}{' '}{moteText("个关联附件")}</small>}</article>)}</section>}


        {['awaiting_confirmation','needs_configuration','failed','unsupported','cancelled'].includes(active.status)&&<ImportInstructions key={active.id} instruction={active.instruction} value={instructionValue} status={active.status} busy={busy} onChange={value=>editInstruction(active.id,value)} onPrepare={value=>void action('/api/imports/'+encodeURIComponent(active.id)+'/prepare',{instruction:value})}/>}
        {active.status==='awaiting_confirmation'&&<div className="confirm-import"><div><strong>{moteText("确认这份资料的理解方式")}</strong><p>{instructionsDirty?moteText('说明已修改，请先重新生成预览。'):moteText("确认后保存记录；记忆整理按自动设置执行，也可稍后手动发起。")}</p></div>{confirmError?.jobId===active.id&&<div className="error-banner" role="alert">{confirmError.message}</div>}<button className="button primary" disabled={busy||instructionsDirty} onClick={confirmImport}><Check size={16}/>{moteText("确认并开始导入")}</button></div>}
        {(active.status==='failed'||active.status==='cancelled'||active.status==='unsupported')&&<button className="button" disabled={busy} onClick={()=>void action('/api/imports/'+encodeURIComponent(active.id)+'/retry')}><RefreshCw size={15}/>{moteText("重试导入")}</button>}
        {active.status==='completed'&&!active.media?.length&&<div className="workflow-line"><span className="workflow-icon done"><Check size={18}/></span><div><strong>{moteText("{0} 条记录已保存",active.captureIds.length)}</strong><p>{active.progress.imported}{' '}{moteText("条新记录 ·")}{' '}{active.progress.duplicates}{' '}{moteText("条重复记录")}</p></div></div>}
        {active.captureIds.length>0&&<section className="import-results"><h3>{moteText('已归档的记录（')}{active.captureIds.length}）</h3><div className="import-saved-list">{active.captureIds.map(id=><ImportResultRow key={id} api={api} id={id} onOpen={onOpen} onRecord={record=>recordOriginal(active.id,record)}/>)}</div></section>}
        {active.memoryProgress&&<section className="import-memory-status" aria-live="polite"><div className="import-memory-state"><span>{moteText('自动记忆')}</span><span>{active.memoryProgress.total>0&&active.memoryProgress.disabled===active.memoryProgress.total?moteText('未启用'):moteText('完成 {0} / {1} · 处理中 {2} · 等待内容或名额 {3}',active.memoryProgress.completed,active.memoryProgress.total,active.memoryProgress.running,active.memoryProgress.pending)}</span></div><details><summary>{moteText('自动记忆进度')}</summary><p>{moteText('按本次新记录接收时选中的配方处理；进度按记录汇总。')}</p><p>{moteText('完成 {0} / {1} · 处理中 {2} · 等待内容或名额 {3}',active.memoryProgress.completed,active.memoryProgress.total,active.memoryProgress.running,active.memoryProgress.pending)}</p><p className="muted">{moteText('失败 {0} · 等待模型 {1} · 暂停 {2} · 已取消 {3} · 未启用 {4} · 输入已变更或不可用 {5}',active.memoryProgress.failed,active.memoryProgress.waitingForModel,active.memoryProgress.paused,active.memoryProgress.cancelled,active.memoryProgress.disabled,active.memoryProgress.unavailable)}</p></details></section>}
        {Boolean(active.media?.length)&&<section className="import-originals"><h3>{moteText('媒体处理进度')}</h3><p className="muted">{moteText('已接入不等于已可搜索。内容提取、搜索和记忆整理分别显示状态。')}</p>{active.media!.map(item=><article className="preview-sample" key={item.fileId}>
          <strong>{active.files.find(file=>file.id===item.fileId)?.relativePath}</strong><p>{mediaStates[item.processing?.state??'']??moteText('原件已归档')} · {item.searchable?moteText('已有可搜索片段'):moteText('尚无可搜索片段')} · {memoryStates[item.memory?.state??'']??moteText('等待内容就绪')}</p>
          {item.processing?.error&&<p role="status">{item.processing.error}</p>}
          {item.captureId&&<><div className="source-toolbar"><button className="button subtle" onClick={()=>onOpen(formatEvidenceRef('capture',item.captureId!))}>{moteText('查看记录')}</button></div><FileProcessingControls key={item.captureId} api={api} id={item.captureId} mode="import" disabled={busy} onChanged={()=>{setRevision(value=>value+1);onChanged();}}/></>}
        </article>)}</section>}
        {memoryJob&&<MemoryProgress job={memoryJob} onRetry={()=>void controlMemory('retry')} onAction={action=>void controlMemory(action)} onView={onMemories} busy={busy}/>}{memoryError&&<p className="error-banner" role="alert">{moteText("记忆进度暂时无法更新：")}{memoryError}</p>}
        {active.status==='completed'&&!active.memoryJobId&&<button className="button" onClick={onMemories}>{moteText("前往记忆")}</button>}
        {active.preview&&active.status==='completed'&&<details className="import-support-preview"><summary>{moteText('解析预览')}</summary><section className="import-preview"><div className="section-heading"><div><h3>{moteText("解析预览")}</h3><p>{active.media?.length?moteText('{0} 条文本记录，{1} 个媒体原件将进入文件处理',active.preview.count-active.media.length,active.media.length):<>{moteText("预计")}{' '}{active.preview.count}{' '}{moteText("条记录 · 以下是内容样例")}</>}</p></div></div>{active.preview.samples.map((sample,index)=><article className="preview-sample" key={index}><strong>{sample.title||moteText("未命名记录")}</strong><p>{sample.text}</p>{sample.attachmentCount>0&&<small>{sample.attachmentCount}{' '}{moteText("个关联附件")}</small>}</article>)}</section></details>}
        {Boolean(active.instruction.trim())&&<details className="import-instructions"><summary>{moteText('本次导入说明')}</summary><p className="file-text">{active.instruction}</p><p className="muted">{moteText('说明按文字中的范围用于理解这次导入的资料，不会把第三方和 AI 引用整批变成你的表达。')}</p></details>}
        {active.summary&&<details className="import-support-preview"><summary>{moteText('解析方式')}</summary><p className="import-summary">{active.summary}</p></details>}
        {(active.reviewGate&&active.status==='completed'||hostDiagnostics.length>0)&&<details className="import-support-preview import-host-diagnostics"><summary>{moteText('运行详情')}</summary>{active.reviewGate&&active.status==='completed'&&<p>{active.reviewGate.decision==='automatic'?moteText('自动发布'):moteText('需要确认')} · {importReviewMessage(active)}</p>}{hostDiagnostics.map((value,index)=><pre key={index}>{value}</pre>)}</details>}
        <details className="import-originals"><summary>{moteText("已保留的原件（")}{active.files.length}）</summary>{active.files.map(file=><div key={file.id} className="file-row"><button className="import-original-row" data-original-id={file.id} onClick={()=>openOriginal(file)}><strong>{file.relativePath||file.name}</strong><small>{bytes(file.sizeBytes)}</small><ChevronRight size={15} aria-hidden="true"/></button><ArchivedFileButton api={api} id={file.id} name={file.name}/></div>)}</details>

        <div className="import-delete">{deleteConfirm===active.id?<><p>{moteText("删除这次导入及不再使用的资料、原件和依赖记忆？其他导入或证据仍引用的共享资料与原件会保留。此操作无法撤销。")}</p><div className="source-toolbar"><button className="button danger" disabled={busy||intakeWorking(active)} onClick={()=>void remove()}>{moteText("确认删除整次导入")}</button><button className="button subtle" disabled={busy} onClick={()=>setDeleteConfirm('')}>{moteText("取消")}</button></div></>:<button className="text-button danger-text" disabled={busy||intakeWorking(active)} onClick={()=>setDeleteConfirm(active.id)}><Trash2 size={13}/>{moteText("删除这次导入")}</button>}</div>
      </div></article>:localEntry?<ImportQueueDetail entry={localEntry} queue={queue} onEdit={editEntry}/>:initialJobId===selected?<div className="panel workspace-empty" role="status"><h2>{moteText(loading?"正在读取…":loadError?"暂不可用":"这次导入当前不可用。")}</h2></div>:<div className="panel workspace-empty"><FolderOpen size={30}/><h2>{moteText("选择一次导入，查看它的来处与进度。")}</h2><button className="button" onClick={()=>setCreating(true)}>{moteText("添加资料")}</button></div>}
      </div>
    </div>
    </div>
  </section>;
}
function ImportResultRow({api,id,onOpen,onRecord}:{api:Api;id:string;onOpen:(ref:string)=>void;onRecord:(record:Capture)=>void}){
 const record=useResource<Capture>(api,'/api/capture-browser/'+encodeURIComponent(id));
 useEffect(()=>{if(record.data?.id===id)onRecord(record.data);},[record.data,id,onRecord]);
 return <button type="button" className="import-result-row" onClick={()=>onOpen(formatEvidenceRef('capture',id))}><strong>{record.data?.id===id&&record.data.windowTitle||moteText('查看记录')}</strong><ChevronRight className="chevron" size={16} aria-hidden="true"/></button>;
}
