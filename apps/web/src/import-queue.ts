import type {ImportJob} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,errorMessage,type Api} from './api';
import {uploadImportFiles} from './import-upload-scheduler';

export type ImportSource={kind:'files';files:readonly File[]}|{kind:'directory';path:string};
export type ImportDraft={source:ImportSource;name:string;instruction:string;sourcePackId:string};
export type ImportQueueState='queued'|'uploading'|'creating'|'waiting'|'paused'|'failed'|'submitted';
export type ImportQueueEntry={
  id:string;name:string;createdAt:string;state:ImportQueueState;uploadedBytes:number;totalBytes:number;
  source:{kind:'files';files:{name:string;size:number}[]}|{kind:'directory';path:string};
  failure?:{message:string;recovery:'retry'|'files'|'directory'};job?:ImportJob;
};
type Task={entry:ImportQueueEntry;draft:ImportDraft;uploadIds:WeakMap<File,string>;archived:WeakMap<File,string>};
type Snapshot={entries:readonly ImportQueueEntry[];completedVersion:number};

export function validateImportFiles(files:readonly File[]):string|undefined{
  if(files.length>2000)return moteText('一次最多选择 2,000 个文件。较多文件可以打包为 ZIP 或使用服务器目录。');
  if(files.some(file=>file.size>64*1024*1024))return moteText('单个上传文件不能超过 64 MB，请拆分文件后导入。');
  if(files.reduce((sum,file)=>sum+file.size,0)>256*1024*1024)return moteText('一次上传的文件总量不能超过 256 MB，请分批导入。');
  if(new Set(files.map(file=>file.webkitRelativePath||file.name)).size!==files.length)return moteText('同一次导入中的文件路径不能重复，请移除重复文件或分开提交。');
}

function failure(error:unknown,source:ImportSource):NonNullable<ImportQueueEntry['failure']>{
  // Recovery follows browser exception names and server protocol codes, never message matching.
  if(source.kind==='files'&&error instanceof Error&&['NotFoundError','NotReadableError'].includes(error.name))return {message:moteText('无法读取所选文件，文件可能已移动或访问权限已失效。请重新选择文件。'),recovery:'files'};
  if(error instanceof Error&&error.name==='TimeoutError')return {message:moteText('上传或提交超时，已上传的分片会保留，请重试这份资料。'),recovery:'retry'};
  if(error instanceof ApiError&&['import_directory_missing','import_directory_unreadable','import_directory_required'].includes(error.code??''))return {message:errorMessage(error),recovery:'directory'};
  return {message:errorMessage(error),recovery:'retry'};
}

/** Session-owned admission queue. Parsing stays in the server's durable execution
 * queue; a preview, failed upload or paused batch never holds an admission slot.
 * Sources and transport are separate from scheduling so new sources can reuse it. */
export class ImportQueue {
  private tasks:Task[]=[];
  private running=new Map<string,AbortController>();
  private listeners=new Set<()=>void>();
  private active=true;
  private generation=0;
  private wakeAt=0;
  private timer?:ReturnType<typeof setTimeout>;
  private snapshot:Snapshot={entries:[],completedVersion:0};
  constructor(private api:Api,private concurrency=2){if(!Number.isInteger(concurrency)||concurrency<1)throw Error('Invalid import queue concurrency');}
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
  private publish(completed=false){this.snapshot={entries:this.tasks.map(task=>task.entry),completedVersion:this.snapshot.completedVersion+(completed?1:0)};for(const listener of this.listeners)listener();}
  private patch(task:Task,change:Partial<ImportQueueEntry>,completed=false){task.entry={...task.entry,...change};this.publish(completed);}
  start(){this.active=true;this.pump();}
  /** Called by the connection owner on logout/node change, never on page navigation. */
  close(){this.active=false;this.generation++;clearTimeout(this.timer);this.timer=undefined;this.wakeAt=0;for(const controller of this.running.values())controller.abort();this.running.clear();this.tasks=[];this.publish();}
  enqueue(input:ImportDraft):string{
    if(!this.active)throw Error(moteText('登录连接已结束，请重新登录后添加资料。'));
    const source:ImportSource=input.source.kind==='files'?{kind:'files',files:[...input.source.files]}:{kind:'directory',path:input.source.path.trim()};
    if(source.kind==='files'){const error=validateImportFiles(source.files);if(error)throw Error(error);if(!source.files.length)throw Error(moteText('请选择导入文件。'));}
    else if(!source.path)throw Error(moteText('请填写中央服务器上的目录。'));
    const draft={...input,name:input.name.trim(),instruction:input.sourcePackId?'':input.instruction,source};
    const name=draft.name||(source.kind==='files'?(source.files.length===1?source.files[0].name:moteText('导入 {0} 个文件',source.files.length)):source.path);
    const entry:ImportQueueEntry={id:crypto.randomUUID(),name,createdAt:new Date().toISOString(),state:'queued',uploadedBytes:0,totalBytes:source.kind==='files'?source.files.reduce((n,file)=>n+file.size,0):0,source:source.kind==='files'?{kind:'files',files:source.files.map(file=>({name:file.webkitRelativePath||file.name,size:file.size}))}:{...source}};
    this.tasks.push({entry,draft,uploadIds:new WeakMap(),archived:new WeakMap()});this.publish();this.pump();return entry.id;
  }
  pause(id:string){const task=this.tasks.find(task=>task.entry.id===id);if(!task||!['queued','uploading','waiting'].includes(task.entry.state))return;this.patch(task,{state:'paused'});this.running.get(id)?.abort();this.pump();}
  retry(id:string){const task=this.tasks.find(task=>task.entry.id===id);if(!task||!['paused','failed'].includes(task.entry.state))return;this.patch(task,{state:'queued',failure:undefined});this.pump();}
  discard(id:string){const task=this.tasks.find(task=>task.entry.id===id);if(!task||['creating','submitted'].includes(task.entry.state))return;this.running.get(id)?.abort();this.tasks=this.tasks.filter(value=>value!==task);this.publish();this.pump();}
  /** Editing starts a fresh request identity; retries keep the frozen original. */
  draft(id:string):ImportDraft|undefined{const task=this.tasks.find(task=>task.entry.id===id);return task?{...task.draft,source:task.draft.source.kind==='files'?{kind:'files',files:[...task.draft.source.files]}:{...task.draft.source}}:undefined;}
  acknowledge(ids:readonly string[]){
    const known=new Set(ids);
    // History is also a receipt for a create response that was lost in transit.
    const remaining=this.tasks.filter(task=>!(task.entry.job&&known.has(task.entry.job.id))&&!(task.entry.state==='failed'&&known.has(task.entry.id)));
    if(remaining.length!==this.tasks.length){this.tasks=remaining;this.publish();}
  }
  private pump(){
    if(!this.active)return;
    if(this.wakeAt>Date.now()){
      if(!this.timer&&this.tasks.some(task=>['queued','waiting'].includes(task.entry.state)))this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},this.wakeAt-Date.now());
      return;
    }
    let resumed=false;for(const task of this.tasks)if(task.entry.state==='waiting'){task.entry={...task.entry,state:'queued'};resumed=true;}
    if(resumed)this.publish();
    while(this.running.size<this.concurrency){const task=this.tasks.find(task=>task.entry.state==='queued'&&!this.running.has(task.entry.id));if(!task)break;const controller=new AbortController();this.running.set(task.entry.id,controller);void this.run(task,controller,this.generation);}
  }
  private async run(task:Task,controller:AbortController,generation:number){
    const current=()=>this.active&&generation===this.generation&&this.tasks.includes(task)&&this.running.get(task.entry.id)===controller;
    try{
      const {draft}=task;
      this.patch(task,{state:draft.source.kind==='files'?'uploading':'creating',failure:undefined});
      const archivedFileIds=draft.source.kind==='files'?await uploadImportFiles(this.api,draft.source.files,task.uploadIds,bytes=>{if(current()&&!controller.signal.aborted)this.patch(task,{uploadedBytes:bytes});},controller.signal,task.archived):undefined;
      controller.signal.throwIfAborted();if(!current())return;
      this.patch(task,{state:'creating'});
      const payload={requestId:task.entry.id,name:draft.name||undefined,instruction:draft.instruction,processing:draft.sourcePackId?'automatic':draft.instruction.trim()?'preview':'automatic',...(draft.sourcePackId?{sourcePackId:draft.sourcePackId}:{}),...(draft.source.kind==='files'?{archivedFileIds}:{directory:draft.source.path})};
      const job=await this.api.request<ImportJob>('/api/imports',{method:'POST',body:JSON.stringify(payload),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
      controller.signal.throwIfAborted();if(!current())return;
      // Release browser File references as soon as the server owns the originals.
      if(task.draft.source.kind==='files')task.draft={...task.draft,source:{kind:'files',files:[]}};
      this.patch(task,{state:'submitted',job},true);
    }catch(error){if(current()&&!controller.signal.aborted){
      if(error instanceof ApiError&&error.status===429){
        this.wakeAt=Math.max(this.wakeAt,Date.now()+Math.min(3600000,Math.max(1,error.retryAfterMs??60000)));
        this.patch(task,{state:'waiting',failure:undefined});
      }else this.patch(task,{state:'failed',failure:failure(error,task.draft.source)});
    }}
    finally{if(this.running.get(task.entry.id)===controller)this.running.delete(task.entry.id);if(generation===this.generation)this.pump();}
  }
}

const queues=new WeakMap<Api,ImportQueue>();
export function importQueue(api:Api){let queue=queues.get(api);if(!queue){queue=new ImportQueue(api);queues.set(api,queue);}return queue;}
