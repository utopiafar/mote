import React,{useEffect,useRef,useState} from 'react';
import {Eye,LoaderCircle,Play,Sparkles} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {AssistantDraft,AssistantDraftCapability} from '@mote/shared';
import {ApiError,type Api} from '../../api';

type Receipt={requestId?:string};

/** The smallest owner entry for a host-validated draft. It can preview the
 * frozen scope without effects; start is only offered when the server reports
 * an installed task handler. Editing creates one new explicit command version. */
export function AssistantDraftActions({api,conversationId,turnId,draft}:{
  api:Api;conversationId:string;turnId:string;draft:AssistantDraft;
}){
  const [goal,setGoal]=useState(draft.goal),[busy,setBusy]=useState(false),[started,setStarted]=useState(false);
  const [status,setStatus]=useState(''),[error,setError]=useState('');
  const content=useRef(draft.goal),requestId=useRef(draft.requestId);
  useEffect(()=>{
    setGoal(draft.goal);setBusy(false);setStarted(false);setStatus('');setError('');
    content.current=draft.goal;requestId.current=draft.requestId;
  },[draft.requestId,draft.revision,draft.goal]);
  const canPreview=draft.capabilities.includes('assistant.task.preview');
  const canStart=draft.capabilities.includes('assistant.task.start');
  const change=(value:string)=>{
    const trimmed=value.trim();
    if(trimmed!==content.current){
      content.current=trimmed;
      requestId.current=trimmed===draft.goal?draft.requestId:crypto.randomUUID();
    }
    setGoal(value);setStatus('');setError('');
  };
  const send=async(capability:AssistantDraftCapability)=>{
    setBusy(true);setStatus('');setError('');
    const trimmed=goal.trim();
    if(trimmed!==content.current){
      content.current=trimmed;
      requestId.current=trimmed===draft.goal?draft.requestId:crypto.randomUUID();
    }
    const body={
      conversationId,turnId,requestId:requestId.current,
      expectedRevision:trimmed===draft.goal?draft.revision:draft.revision+1,
      capability,goal:trimmed,scope:draft.scope,
    };
    try{
      const receipt=await api.request<Receipt>('/api/assistant/commands',{method:'POST',body:JSON.stringify(body)});
      if(receipt?.requestId!==body.requestId)throw new Error('Assistant command receipt identity changed');
      if(capability==='assistant.task.start'){setStarted(true);setStatus(moteText('草稿已开始。'));}
      else setStatus(moteText('草稿范围已确认。'));
    }catch(reason){
      if(reason instanceof ApiError&&[403,404,409,410].includes(reason.status))
        setError(moteText('这份草稿已失效，请回到原回答重新生成。'));
      else setError(moteText('草稿提交失败，请重试。'));
    }finally{setBusy(false);}
  };
  return <section className="assistant-draft" aria-label={moteText('建议的下一步')} aria-busy={busy}>
    <div className="assistant-draft-heading"><Sparkles size={14}/><strong>{moteText('建议的下一步')}</strong></div>
    <p>{moteText('这份草稿可以修改后再开始。')}</p>
    <label>{moteText('工作目标')}
      <textarea aria-label={moteText('工作目标')} value={goal} maxLength={8000} rows={2} disabled={busy||started} onChange={event=>change(event.target.value)}/>
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
  </section>;
}
