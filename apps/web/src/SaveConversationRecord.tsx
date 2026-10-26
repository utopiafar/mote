import {useUnsavedChanges} from './unsaved';
import {useRef,useState} from 'react';
import {formatEvidenceRef} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
/** The owner reviews a quoted answer and adds their own comment before creating a record. */
export function SaveConversationRecord({api,conversationId,messageId,question,answer,onOpen}:{api:Api;conversationId:string;messageId:string;question:string;answer:string;onOpen:(ref:string)=>void}){
 const [editing,setEditing]=useState(false),[comment,setComment]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState<string>();
 useUnsavedChanges(editing&&Boolean(comment)&&!saved);
 const identity=useRef<{id:string;capturedAt:string}|undefined>(undefined);
 const submitting=useRef(false);
 const original=question+'\n\n'+answer;
 async function save(){
  if(submitting.current)return;submitting.current=true;setBusy(true);setError('');identity.current??={id:crypto.randomUUID(),capturedAt:new Date().toISOString()};
  try{const {id,capturedAt}=identity.current;let deviceId=localStorage.getItem('mote.notes.device.v1');if(!deviceId){deviceId='web:'+crypto.randomUUID();localStorage.setItem('mote.notes.device.v1',deviceId);}
   const result=await api.request<{id:string}>('/api/notes',{method:'POST',body:JSON.stringify({client:'web',id,capturedAt,deviceId,deviceName:'Mote Web',platform:'import',text:comment,metadata:{version:1,observedAt:capturedAt,noteOrigin:{kind:'conversation',text:original,conversationId,messageIds:[messageId]}}})});setSaved(result.id);setEditing(false);
  }catch(cause){setError(errorMessage(cause));}finally{submitting.current=false;setBusy(false);}
 }
 if(saved)return <button className="text-button" onClick={()=>onOpen(formatEvidenceRef('capture',saved))}>{moteText('查看已保存记录')}</button>;
 return <div className="save-conversation-record">{!editing?<button className="text-button" onClick={()=>setEditing(true)}>{moteText('保存为记录')}</button>:<form className="panel panel-pad" onSubmit={event=>{event.preventDefault();void save();}}><h3>{moteText('保存为记录')}</h3><details><summary>{moteText('引用原文')}</summary><h4>{moteText('用户问题')}</h4><pre>{question}</pre><h4>{moteText('AI 回答')}</h4><pre>{answer}</pre></details><label>{moteText('我的补充')}<textarea value={comment} onChange={event=>{setComment(event.target.value);identity.current=undefined;}} maxLength={100000} disabled={busy}/></label>{error&&<p role="alert">{error}</p>}<div className="filter-bar"><button className="button primary" type="submit" disabled={busy||original.length>100000}>{moteText('确认保存')}</button><button className="button subtle" type="button" disabled={busy} onClick={()=>setEditing(false)}>{moteText('取消')}</button></div></form>}</div>;
}
