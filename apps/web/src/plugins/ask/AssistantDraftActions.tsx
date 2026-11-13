import React,{useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {Eye,LoaderCircle,Play,Sparkles} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {AssistantDraft,AssistantDraftCapability} from '@mote/shared';
import {ApiError,type Api,type Answer} from '../../api';
import {AssistantTaskResults,type AssistantTaskResultItem} from './AssistantTaskResults';

type Receipt={requestId?:string};

/** The smallest owner entry for a host-validated draft. It can preview the
 * frozen scope without effects; start is only offered when the server reports
 * an installed task handler. Editing creates one new explicit command version. */
export function AssistantDraftActions({api,conversationId,turnId,draft,renderAnswer,onOpen}:{
  api:Api;conversationId:string;turnId:string;draft:AssistantDraft;
  renderAnswer?:(answer:Answer,open:(ref:string)=>void)=>ReactNode;onOpen?:(ref:string)=>void;
}){
  const [goal,setGoal]=useState(draft.goal),[busy,setBusy]=useState(false),[started,setStarted]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [status,setStatus]=useState(''),[error,setError]=useState('');
  const editing=useRef(false);
  const content=useRef(draft.goal),requestId=useRef(draft.requestId);
  const revision=useRef(draft.revision),accepted=useRef<{revision:number;goal?:string;requestId?:string}|undefined>(undefined);
  const found=useCallback((items:AssistantTaskResultItem[])=>{
    const latest=items.reduce((current,item)=>!current||(item.expectedRevision??draft.revision)>(current.expectedRevision??draft.revision)?item:current,undefined as AssistantTaskResultItem|undefined);
    if(latest){const value=latest.expectedRevision??draft.revision;if(!accepted.current||value>=accepted.current.revision)accepted.current={revision:value,goal:latest.task.goal,requestId:latest.task.requestId};}
    if(!editing.current)setStarted(true);
  },[draft.revision]);
  useEffect(()=>{
    setGoal(draft.goal);setBusy(false);setStarted(false);setStatus('');setError('');
    content.current=draft.goal;requestId.current=draft.requestId;revision.current=draft.revision;accepted.current=undefined;editing.current=false;
  },[draft.requestId,draft.revision,draft.goal]);
  const canPreview=draft.capabilities.includes('assistant.task.preview');
  const canStart=draft.capabilities.includes('assistant.task.start');
  const assign=(trimmed:string)=>{
    if(trimmed!==content.current){
      content.current=trimmed;
      editing.current=true;
      const previous=accepted.current;
      if(previous&&trimmed===previous.goal){revision.current=previous.revision;requestId.current=previous.requestId??requestId.current;setStarted(true);}
      else if(!previous&&trimmed===draft.goal){revision.current=draft.revision;requestId.current=draft.requestId;setStarted(false);}
      else{revision.current=(previous?.revision??draft.revision)+1;requestId.current=crypto.randomUUID();setStarted(false);}
    }
  };
  const change=(value:string)=>{
    assign(value.trim());
    setGoal(value);setStatus('');setError('');
  };
  const send=async(capability:AssistantDraftCapability)=>{
    setBusy(true);setStatus('');setError('');
    const trimmed=goal.trim();
    assign(trimmed);
    const body={
      conversationId,turnId,requestId:requestId.current,
      expectedRevision:revision.current,
      capability,goal:trimmed,scope:draft.scope,
    };
    try{
      const receipt=await api.request<Receipt>('/api/assistant/commands',{method:'POST',body:JSON.stringify(body)});
      if(receipt?.requestId!==body.requestId)throw new Error('Assistant command receipt identity changed');
      if(capability==='assistant.task.start'){accepted.current={revision:body.expectedRevision,goal:body.goal,requestId:body.requestId};editing.current=false;setStarted(true);setStatus(moteText('任务已创建。'));setRefresh(value=>value+1);}
      else setStatus(moteText('草稿范围已确认。'));
    }catch(reason){
      if(reason instanceof ApiError&&reason.status===413)
        setError(moteText('处理服务拒绝了内容大小，请缩小本次处理范围。'));
      else if(reason instanceof ApiError&&[403,404,409,410].includes(reason.status))
        setError(moteText('这份草稿已失效，请回到原回答重新生成。'));
      else setError(moteText('草稿提交失败，请重试。'));
    }finally{setBusy(false);}
  };
  return <section className="assistant-draft" aria-label={moteText('建议的下一步')} aria-busy={busy}>
    <div className="assistant-draft-heading"><Sparkles size={14}/><strong>{moteText('建议的下一步')}</strong></div>
    <p>{moteText('这份草稿可以修改后再开始。')}</p>
    <label>{moteText('工作目标')}
      <textarea aria-label={moteText('工作目标')} value={goal} maxLength={8000} rows={2} disabled={busy} onChange={event=>change(event.target.value)}/>
    </label>
    <div className="assistant-draft-actions">
      {canStart?<button type="button" className="button primary" disabled={busy||started||!goal.trim()} onClick={()=>void send('assistant.task.start')}>
        {busy?<LoaderCircle className="spin" size={15}/>:<Play size={14}/>}{moteText('开始')}
      </button>:<button type="button" className="button primary" disabled title={moteText('任务服务尚未接通，暂时不能开始。')}>{moteText('开始')}</button>}
      {canPreview&&<button type="button" className={canStart?'button subtle':'button'} disabled={busy||started||!goal.trim()} onClick={()=>void send('assistant.task.preview')}>
        {busy?<LoaderCircle className="spin" size={15}/>:<Eye size={14}/>}{moteText('查看将使用的范围')}
      </button>}
    </div>
    {!canStart&&<p className="assistant-draft-note">{moteText('任务服务尚未接通，暂时不能开始。')}</p>}
    {status&&<p className="assistant-draft-status" role="status">{status}</p>}
    {error&&<p className="assistant-draft-status error" role="alert">{error}</p>}
    {canStart&&renderAnswer&&onOpen&&<AssistantTaskResults api={api} conversationId={conversationId} turnId={turnId} scope={draft.scope}
      refresh={refresh} renderAnswer={renderAnswer} onOpen={onOpen} onFound={found}/>}
  </section>;
}
