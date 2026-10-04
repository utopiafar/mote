import React from 'react';
import {FileText,LoaderCircle} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {bytes} from './api';
import type {ImportQueue,ImportQueueEntry as Entry} from './import-queue';

function stateLabel(entry:Entry){
  switch(entry.state){
    case 'queued':return moteText('等待上传或提交');
    case 'uploading':return moteText('正在上传原件');
    case 'creating':return moteText('正在提交到服务器');
    case 'waiting':return moteText('服务暂时限流，将自动继续');
    case 'paused':return moteText('上传已暂停');
    case 'failed':return moteText('需要处理');
    case 'submitted':return moteText('原件已归档');
  }
}
function Progress({entry}:{entry:Entry}){return entry.source.kind==='files'&&<div className="import-upload-progress"><small>{bytes(entry.uploadedBytes)} / {bytes(entry.totalBytes)}</small><progress aria-label={moteText('文件上传进度')} value={entry.uploadedBytes} max={entry.totalBytes||1}/></div>;}
function Controls({entry,queue,onEdit}:{entry:Entry;queue:ImportQueue;onEdit:(entry:Entry)=>void}){
  return <div className="import-queue-actions">
    {['queued','uploading','waiting'].includes(entry.state)&&<button className="text-button" onClick={()=>queue.pause(entry.id)}>{moteText('暂停上传')}</button>}
    {entry.state==='paused'&&<button className="text-button" onClick={()=>queue.retry(entry.id)}>{moteText('继续上传')}</button>}
    {entry.state==='failed'&&<button className="text-button" onClick={()=>queue.retry(entry.id)}>{moteText('重试提交')}</button>}
    {entry.failure?.recovery==='files'&&<button className="text-button" onClick={()=>onEdit(entry)}>{moteText('重新选择文件')}</button>}
    {entry.failure?.recovery==='directory'&&<button className="text-button" onClick={()=>onEdit(entry)}>{moteText('修改目录')}</button>}
    {entry.state!=='creating'&&entry.state!=='submitted'&&<button className="text-button" onClick={()=>queue.discard(entry.id)}>{moteText('移出队列')}</button>}
  </div>;
}
export function ImportQueueRow({entry,queue,selected,onSelect,onEdit}:{entry:Entry;queue:ImportQueue;selected:boolean;onSelect:()=>void;onEdit:(entry:Entry)=>void}){
  return <div className={'import-queue-item '+(selected?'active':'')} role="group" aria-label={entry.name}>
    <button className={'workspace-select '+(selected?'active':'')} aria-pressed={selected} onClick={onSelect}><strong>{entry.name}</strong><span className={'status-label '+(['failed','paused'].includes(entry.state)?'attention':'')}>{['uploading','creating'].includes(entry.state)&&<LoaderCircle size={12} className="spin"/>}{stateLabel(entry)}</span><small>{entry.source.kind==='files'?moteText('{0} 个文件',entry.source.files.length):moteText('服务器目录')}</small></button>
    <Progress entry={entry}/>
    {entry.failure&&!selected&&<p className="import-queue-error" role="alert">{entry.failure.message}</p>}
    <Controls entry={entry} queue={queue} onEdit={onEdit}/>
  </div>;
}
export function ImportQueueDetail({entry,queue,onEdit}:{entry:Entry;queue:ImportQueue;onEdit:(entry:Entry)=>void}){
  return <article className="panel import-detail import-upload-detail">
    <div className="section-heading"><div><div className="eyebrow">{stateLabel(entry)}</div><h2>{entry.name}</h2><p>{moteText('每份资料独立处理，可以继续添加其他资料。')}</p></div></div>
    <Progress entry={entry}/>
    {entry.state==='paused'&&<p className="notice" role="status">{moteText('上传已暂停，文件和已上传的分片仍保留，点击继续上传即可恢复。')}</p>}
    {entry.state==='creating'&&<p role="status">{moteText('正在归档并提交任务，请等待服务器返回。')}</p>}
    {entry.failure&&<div className="error-banner" role="alert">{entry.failure.message}</div>}
    <Controls entry={entry} queue={queue} onEdit={onEdit}/>
    {entry.source.kind==='files'?<section className="import-originals"><h3>{moteText('本次提交的文件')}</h3>{entry.source.files.map(file=><div className="file-row" key={file.name}><FileText size={15}/><span>{file.name}</span><small>{bytes(file.size)}</small></div>)}</section>:<p className="import-source-path">{entry.source.path}</p>}
    <p className="muted">{moteText('已归档的原件会保留。未上传完的本地文件需保持当前浏览器会话，刷新或关闭后请重新选择。')}</p>
  </article>;
}
