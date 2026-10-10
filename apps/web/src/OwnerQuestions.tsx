import React,{useEffect,useRef,useState} from 'react';
import {ArrowUp,ArrowRight,LoaderCircle,MessageSquare} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {OwnerQuestion} from '@mote/shared';
import {ApiError,dateTime,errorMessage,type Api} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {ConversationHeading,ConversationComposer} from './ConversationShell';
import {ownerQuestionListPath,ownerQuestionRoute} from './owner-question-route';

type QuestionPage={items:OwnerQuestion[];nextCursor:string|null};
const stateLabel=(state:OwnerQuestion['state'])=>({open:moteText('待回答'),deferred:moteText('稍后处理'),answered:moteText('已回答'),closed:moteText('已结束'),obsolete:moteText('已失效')}[state]);

export function OwnerQuestionLinks({api,workId,materialId,operationIds,history=false,selectedId}:{api:Api;workId?:string;materialId?:string;operationIds?:string[];history?:boolean;selectedId?:string}){
  const [cursor,setCursor]=useState<string>();
  const operationScope=operationIds?.length?JSON.stringify(operationIds.slice(0,100)):undefined;
  const path=ownerQuestionListPath({...(workId?{workId}:{}),...(materialId?{materialId}:{}),...(operationScope?{operationIds:JSON.parse(operationScope) as string[]}:{})},cursor,history?'open,deferred':'open,deferred,closed,answered');
  const page=useResource<QuestionPage>(api,path,5000);
  useEffect(()=>setCursor(undefined),[api,workId,materialId,operationScope]);
  const items=page.error===undefined&&Array.isArray(page.data?.items)?page.data.items:[];
  if(!items.length&&!page.error&&!page.loading&&!page.data?.nextCursor)return null;
  return <section className={history?'owner-question-history':'owner-question-links'} aria-label={history?moteText('需要你补充'):moteText('补充问题记录')}>
    <h3>{history?moteText('需要你补充'):moteText('补充问题记录')}</h3>
    {page.error!==undefined&&<p className="notice error" role="alert">{errorMessage(page.error)} <button className="text-button" onClick={page.refresh}>{moteText('重试')}</button></p>}
    {page.loading&&!page.data&&<p role="status">{moteText('正在读取…')}</p>}
    <div className={history?'conversation-list':'processing-actions'}>{items.map(question=><a className={history?`conversation-item ${selectedId===question.id?'active':''}`:'button subtle'} key={question.id} href={ownerQuestionRoute(question.id)} aria-current={selectedId===question.id?'page':undefined}><strong>{question.title}</strong><span>{stateLabel(question.state)}{history&&<> · {dateTime(question.updatedAt)}</>}</span>{!history&&<ArrowRight size={15}/>}</a>)}</div>
    <div className="processing-actions">{cursor&&<button className="text-button" onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}{page.data?.nextCursor&&<button className="text-button" onClick={()=>setCursor(page.data!.nextCursor!)}>{moteText('继续展开')}</button>}</div>
  </section>;
}

type Reply={requestId:string;expectedRevision:number;action:'answer'|'unknown'|'defer';answer?:string;choiceId?:string};
export function OwnerQuestionConversation({api,id,onOpen}:{api:Api;id:string;onOpen:(ref:string)=>void}){
  const path='/api/owner-questions/'+encodeURIComponent(id),detail=useResource<OwnerQuestion>(api,path,3000);
  const [accepted,setAccepted]=useState<{api:Api;id:string;value:OwnerQuestion}>(),[draft,setDraft]=useState(''),[choiceId,setChoiceId]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reopened,setReopened]=useState(false);
  const controller=useRef<AbortController|null>(null),pending=useRef<{fingerprint:string;body:Reply}|undefined>(undefined),identity=useRef({api,id});identity.current={api,id};
  const copied=accepted?.api===api&&accepted.id===id?accepted.value:undefined;
  const question=detail.error===undefined?(copied&&(!detail.data||copied.revision>=detail.data.revision)?copied:detail.data):undefined;
  useEffect(()=>{setAccepted(undefined);setDraft('');setChoiceId(undefined);setBusy(false);setError('');setReopened(false);pending.current=undefined;return()=>{controller.current?.abort();controller.current=null;};},[api,id]);
  useEffect(()=>{if(detail.error instanceof ApiError&&[401,403,404,410].includes(detail.error.status)){setAccepted(undefined);setDraft('');setChoiceId(undefined);setReopened(false);}},[detail.error]);
  const showComposer=question&&(['open','deferred'].includes(question.state)||question.state==='closed'&&reopened);
  const canReply=showComposer&&!busy;
  async function reply(action:Reply['action']){
    if(!question||!canReply||controller.current)return;
    const text=draft.trim();if(action==='answer'&&!choiceId&&!text)return;
    const input={expectedRevision:question.revision,action,...action==='answer'?(choiceId?{choiceId}:{answer:draft}):{}};
    const fingerprint=JSON.stringify(input),body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,requestId:crypto.randomUUID()};
    pending.current={fingerprint,body};
    const request=new AbortController();controller.current=request;setBusy(true);setError('');
    const current=()=>!request.signal.aborted&&controller.current===request&&identity.current.api===api&&identity.current.id===id;
    try{
      const value=await api.request<OwnerQuestion>(path+'/reply',{method:'POST',signal:request.signal,body:JSON.stringify(body)});
      if(!current())return;
      setAccepted({api,id,value});setDraft('');setChoiceId(undefined);setReopened(false);pending.current=undefined;
      resources(api).invalidate(key=>key.startsWith('/api/owner-questions')||key.startsWith('/api/work-activity')||key.startsWith('/api/materials'));
    }catch(e){if(current()){
      setError(e instanceof ApiError&&e.status===409?moteText('这个问题已更新，请查看最新内容后再回答。'):errorMessage(e));
      if(e instanceof ApiError&&[401,403,404,409,410].includes(e.status)){pending.current=undefined;setAccepted(undefined);detail.refresh();}
    }}finally{if(current()){setBusy(false);controller.current=null;}}
  }
  const evidence=question?.evidence??[];
  return <section className="conversation-content owner-question-conversation" aria-label={moteText('补充资料对话')} aria-busy={busy||detail.loading}>
    <ConversationHeading title={question?.title||moteText('需要你补充')} description={moteText('补充后，仅继续处理这份资料')}/>
    {detail.loading&&!question&&<p role="status">{moteText('正在打开对话…')}</p>}
    {Boolean(error||detail.error)&&<p className="notice error" role="alert">{error||errorMessage(detail.error)} <button className="text-button" disabled={busy} onClick={detail.refresh}>{moteText('刷新')}</button></p>}
    {question&&<>
      <div className="conversation-messages" aria-live="polite">
        <p className="fine-print">{stateLabel(question.state)}</p>
        {question.reason&&<p>{question.reason}</p>}
        <details className="owner-question-evidence" open><summary>{moteText('查看相关原文')}</summary>{evidence.map(item=><div key={item.id}><blockquote className="file-text">{item.quote}</blockquote>{item.ref&&<button className="text-button" onClick={()=>onOpen(item.ref!)}>{moteText('查看原始记录')}<ArrowRight size={14}/></button>}</div>)}{question.materialRef&&<button className="text-button" onClick={()=>onOpen(question.materialRef!)}>{moteText('打开来源资料')}<ArrowRight size={14}/></button>}</details>
        {question.messages.map((message,index)=><article className="answer-panel conversation-turn" key={index}>{message.role==='user'?<div className="asked-question"><MessageSquare size={16}/><span className="file-text">{message.text}</span></div>:<div className="answer-copy file-text">{message.text}</div>}</article>)}
        {!question.messages.length&&<article className="answer-panel"><p className="file-text">{question.prompt}</p></article>}
        {question.outcome&&<p className="notice" role="status">{question.outcome}</p>}
        {question.state==='answered'&&<p className="fine-print">{moteText('回答已记录，后续处理状态请查看活动；成果审核完成后才会保存。')}</p>}
        {question.state==='deferred'&&<p className="fine-print">{moteText('已放到稍后处理，其他工作继续；回来后仍可回答。')}</p>}
        {question.state==='closed'&&<p className="fine-print">{moteText('已保留资料和不确定性，本次不再追问。')}</p>}
        {question.state==='obsolete'&&<p className="fine-print">{moteText('来源或处理版本已变化，这个问题不再接受回答。')}</p>}
      </div>
      {question.state==='closed'&&!reopened&&<div className="processing-actions"><button className="button subtle" onClick={()=>setReopened(true)}>{moteText('我有新信息了')}</button></div>}
      {showComposer&&<>
        <div className="suggestions owner-question-choices">{question.choices.map(choice=><button key={choice.id} disabled={!canReply} aria-pressed={choiceId===choice.id} onClick={()=>{setChoiceId(choice.id);setDraft(choice.answer);}}>{choice.label}</button>)}</div>
        <ConversationComposer label={moteText('回复补充问题')} placeholder={moteText('补充你知道的信息，也可以选择上面的回答。')} value={draft} onChange={value=>{setDraft(value);setChoiceId(undefined);}} onSubmit={()=>void reply('answer')} disabled={!canReply} maxLength={6000}>
          <div><span>{moteText('回答只用于这份资料')}</span><button className="send-button" type="submit" disabled={!canReply||!draft.trim()} aria-label={moteText('回答并继续')}>{busy?<LoaderCircle className="spin" size={19}/>:<ArrowUp size={19}/>}</button></div>
        </ConversationComposer>
        <div className="processing-actions owner-question-actions"><button className="text-button" disabled={!canReply} onClick={()=>void reply('unknown')}>{moteText('我也不知道，结束这次追问')}</button><button className="text-button" disabled={!canReply} onClick={()=>void reply('defer')}>{moteText('稍后再说')}</button></div>
      </>}
    </>}
  </section>;
}
