import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowRight,LoaderCircle} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {OwnerQuestion} from '@mote/shared';
import {ApiError,dateTime,errorMessage,type Api} from '../../api';
import {useResource} from '../../useResource';
import {resources} from '../../resource-cache';
import {ConversationHeading} from '../../ConversationShell';
import {ownerQuestionListPath,ownerQuestionRoute,ownerQuestionListOrigin,clearOwnerQuestionListOrigin,readOwnerQuestion} from '../../owner-question-route';
import {guideVisit} from '../../feature-guide-state';

type Reply={requestId:string;expectedRevision:number;action:'answer'|'unknown'|'defer';answer?:string;choiceId?:string};
type QuestionDraft={draft:string;choiceId?:string;reopened:boolean;pending?:{fingerprint:string;body:Reply}};
const questionDrafts=new WeakMap<Api,Map<string,QuestionDraft>>();
const questionVisits=new WeakMap<Api,{filter:'pending'|'all';cursor?:string}>();
type QuestionReturn={hash:string;scroll:number;opener:HTMLElement|null;questionId:string};
const questionOrigins=new WeakMap<Api,Map<string,QuestionReturn>>();
const questionReturns=new WeakMap<Api,QuestionReturn>();
function rememberQuestion(api:Api,id:string){let all=questionOrigins.get(api);if(!all){all=new Map();questionOrigins.set(api,all);}all.set(id,{hash:window.location.hash,scroll:window.scrollY,opener:document.activeElement as HTMLElement|null,questionId:id});}
function draftFor(api:Api,id:string){let all=questionDrafts.get(api);if(!all){all=new Map();questionDrafts.set(api,all);}let value=all.get(id);if(!value){value={draft:'',reopened:false};all.set(id,value);}return value;}
type QuestionPage={items:OwnerQuestion[];nextCursor:string|null};
const presentationHref=new URL('../../owner-question-final.css',import.meta.url).href;
function useOwnerQuestionStyle(){useEffect(()=>{if(document.head.querySelector('link[data-mote-owner-question-final]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=presentationHref;link.dataset.moteOwnerQuestionFinal='true';document.head.append(link);},[]);}
const foregroundQuestions=new WeakSet<object>();
function useQuestionForeground(api:Api,path:string){
 useEffect(()=>{
  const resource=resources(api).get(path);let hidden=document.hidden;
  const visibility=()=>{
   if(hidden===document.hidden)return;hidden=document.hidden;
   if(hidden||foregroundQuestions.has(resource))return;
   foregroundQuestions.add(resource);
   // One hint per Api/key, including when several question views share it.
   queueMicrotask(()=>{foregroundQuestions.delete(resource);if(!document.hidden&&resource.observed)resource.invalidate();});
  };
  document.addEventListener('visibilitychange',visibility);
  return()=>document.removeEventListener('visibilitychange',visibility);
 },[api,path]);
}
const stateLabel=(state:OwnerQuestion['state'])=>({open:moteText('待回答'),deferred:moteText('稍后处理'),answered:moteText('已回答'),closed:moteText('已结束'),obsolete:moteText('已失效')}[state]);

export function OwnerQuestionWorkspace({api,id,onOpen}:{api:Api;id:string;onOpen:(ref:string)=>void}){
  useOwnerQuestionStyle();
  useEffect(()=>()=>{queueMicrotask(()=>{if(readOwnerQuestion(window.location.hash)===null)clearOwnerQuestionListOrigin(api);});},[api]);
  const returnTo=id?questionOrigins.get(api)?.get(id)?.hash??ownerQuestionRoute():ownerQuestionListOrigin(api)??(guideVisit(api).returnAvailable?'#/guide':'#/');
  return <div className="owner-question-workspace"><div className="owner-question-workspace-header">{!id&&<h1>{moteText('需要你补充')}</h1>}<a className="text-button" href={returnTo} onClick={()=>{const position=id?questionOrigins.get(api)?.get(id):undefined;if(position)questionReturns.set(api,position);}}>← {moteText('返回')}</a></div>{id?<OwnerQuestionConversation key={id} api={api} id={id} onOpen={onOpen} standalone/>:<OwnerQuestionLinks api={api} history standalone/>}</div>;
}

export function OwnerQuestionLinks({api,workId,materialId,operationIds,history=false,selectedId,standalone=false}:{api:Api;workId?:string;materialId?:string;operationIds?:string[];history?:boolean;selectedId?:string;standalone?:boolean}){
  useOwnerQuestionStyle();
  const [filter,setFilter]=useState<'pending'|'all'>(()=>standalone?questionVisits.get(api)?.filter??'pending':'pending');
  const operationScope=operationIds?.length?JSON.stringify(operationIds.slice(0,100)):undefined;
  const scope=JSON.stringify([workId??null,materialId??null,operationScope??null]);
  const [paging,setPaging]=useState<{api:Api;scope:string;cursor?:string}>(()=>({api,scope,...(standalone?{cursor:questionVisits.get(api)?.cursor}:{})}));
  const cursor=paging.api===api&&paging.scope===scope?paging.cursor:undefined;
  const setCursor=(cursor?:string)=>{setPaging({api,scope,cursor});if(standalone)questionVisits.set(api,{filter,cursor});};
  useEffect(()=>{if(standalone)questionVisits.set(api,{filter,cursor});},[api,standalone,filter,cursor]);
  const path=ownerQuestionListPath({...(workId?{workId}:{}),...(materialId?{materialId}:{}),...(operationScope?{operationIds:JSON.parse(operationScope) as string[]}:{})},cursor,history?(filter==='pending'?'open,deferred':'open,deferred,answered,closed,obsolete'):'open,deferred,closed,answered');
  const page=useResource<QuestionPage>(api,path,5000);
  useQuestionForeground(api,path);
  const items=page.error===undefined&&Array.isArray(page.data?.items)?page.data.items:[];
  useLayoutEffect(()=>{
    const position=questionReturns.get(api);if(!standalone||!page.data||page.error||!position||position.hash!==window.location.hash)return;
    const frame=window.requestAnimationFrame(()=>{if(questionReturns.get(api)!==position||window.location.hash!==position.hash)return;questionReturns.delete(api);const opener=position.opener?.isConnected?position.opener:[...document.querySelectorAll<HTMLAnchorElement>('.owner-question-history a')].find(link=>link.getAttribute('href')===ownerQuestionRoute(position.questionId));opener?.focus({preventScroll:true});window.scrollTo(0,position.scroll);});
    return()=>window.cancelAnimationFrame(frame);
  },[api,standalone,page.data,page.error]);
  if(!history&&!items.length&&!page.error&&(!page.loading||page.data!==undefined)&&!page.data?.nextCursor)return null;
  return <section className={history?'owner-question-history owner-question-final':'owner-question-links owner-question-final'} aria-label={history?moteText('需要你补充'):moteText('补充问题记录')}>
    {!standalone&&<h3>{history?moteText('需要你补充'):moteText('补充问题记录')}</h3>}
    {history&&<nav className="owner-question-tabs" aria-label={moteText('补充问题记录')}>{([['pending','待回答'],['all','全部记录']] as const).map(([key,label])=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>{setCursor(undefined);setFilter(key);}}>{moteText(label)}</button>)}</nav>}
    {page.error!==undefined&&<p className="notice error" role="alert">{errorMessage(page.error)} <button className="text-button" onClick={page.refresh}>{moteText('重试')}</button></p>}
    {page.loading&&!page.data&&<p role="status">{moteText('正在读取…')}</p>}
    {history&&(!page.loading||page.data!==undefined)&&!page.error&&!items.length&&!page.data?.nextCursor&&<p className="owner-question-empty" role="status">{moteText(filter==='pending'?'没有待回答的问题':'暂无补充问题记录')}</p>}
    <div className={history?'conversation-list':'processing-actions'}>{items.map(question=><a className={history?`conversation-item ${selectedId===question.id?'active':''}`:'button subtle'} key={question.id} href={ownerQuestionRoute(question.id)} onClick={()=>rememberQuestion(api,question.id)} aria-current={selectedId===question.id?'page':undefined}><strong>{question.title||stateLabel(question.state)}</strong><span>{stateLabel(question.state)}{history&&<> · {standalone?<QuestionSource api={api} reference={question.materialRef}/>:dateTime(question.updatedAt)}</>}</span>{history&&<ArrowRight size={13}/>}{!history&&<ArrowRight size={15}/>}</a>)}</div>
    <div className="processing-actions">{cursor&&<button className="text-button" onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}{page.data?.nextCursor&&<button className="text-button" onClick={()=>setCursor(page.data!.nextCursor!)}>{moteText('继续展开')}</button>}</div>
  </section>;
}

function QuestionSource({api,reference}:{api:Api;reference?:string}){
 const match=reference?.match(/^material:([^@]+)@(.+)$/);
 const read=useResource<{material:{ref:string;title:string}}>(api,match?'/api/materials/'+encodeURIComponent(match[1])+'/read?'+new URLSearchParams({revision:match[2],length:'1'}):null);
 return <>{!read.error&&read.data?.material?.ref===reference&&read.data?.material?read.data.material.title:moteText('资料')}</>;
}
export function OwnerQuestionConversation({api,id,onOpen,standalone=false}:{api:Api;id:string;onOpen:(ref:string)=>void;standalone?:boolean}){
  useOwnerQuestionStyle();
  const path='/api/owner-questions/'+encodeURIComponent(id),detail=useResource<OwnerQuestion>(api,path,3000);
  useQuestionForeground(api,path);
  const [accepted,setAccepted]=useState<{api:Api;id:string;value:OwnerQuestion}>(),[draftState,setDraftState]=useState(()=>({api,id,...draftFor(api,id)})),[busy,setBusy]=useState(false),[error,setError]=useState(''),[workBusy,setWorkBusy]=useState(false),[workError,setWorkError]=useState('');
  const retained=draftState.api===api&&draftState.id===id?draftState:draftFor(api,id);
  const {draft,choiceId,reopened}=retained;
  const edit=(patch:Partial<QuestionDraft>)=>{const next={...draftFor(api,id),...patch};questionDrafts.get(api)!.set(id,next);setDraftState({api,id,...next});};
  const setDraft=(draft:string)=>edit({draft}),setChoiceId=(choiceId:string|undefined)=>edit({choiceId}),setReopened=(reopened:boolean)=>edit({reopened});
  const workController=useRef<AbortController|null>(null);
  const controller=useRef<AbortController|null>(null),pending=useRef<{fingerprint:string;body:Reply}|undefined>(draftFor(api,id).pending),identity=useRef({api,id});identity.current={api,id};
  const copied=accepted?.api===api&&accepted.id===id?accepted.value:undefined;
  const question=detail.error===undefined?(copied&&(!detail.data||copied.revision>=detail.data.revision)?copied:detail.data):undefined;
  useEffect(()=>{setAccepted(undefined);setDraftState({api,id,...draftFor(api,id)});setBusy(false);setError('');setWorkBusy(false);setWorkError('');pending.current=draftFor(api,id).pending;return()=>{controller.current?.abort();controller.current=null;workController.current?.abort();workController.current=null;};},[api,id]);
  useEffect(()=>{if(detail.error instanceof ApiError&&[401,403,404,410].includes(detail.error.status)){controller.current?.abort();controller.current=null;setBusy(false);setError('');setAccepted(undefined);edit({draft:'',choiceId:undefined,reopened:false,pending:undefined});pending.current=undefined;}},[detail.error]);
  const latestQuestion=useRef(question);latestQuestion.current=question;
  useEffect(()=>{workController.current?.abort();workController.current=null;setWorkBusy(false);setWorkError('');},[api,id,question?.revision,question?.state]);
  const showComposer=question&&(['open','deferred'].includes(question.state)||question.state==='closed'&&reopened);
  const canReply=showComposer&&!busy;
  async function reply(action:Reply['action']){
    if(!question||!canReply||controller.current)return;
    const text=draft.trim();if(action==='answer'&&!choiceId&&!text)return;
    const input={expectedRevision:question.revision,action,...action==='answer'?(choiceId?{choiceId}:{answer:draft}):{}};
    const fingerprint=JSON.stringify(input),body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,requestId:crypto.randomUUID()};
    pending.current={fingerprint,body};edit({pending:pending.current});
    const request=new AbortController();controller.current=request;setBusy(true);setError('');
    const current=()=>!request.signal.aborted&&controller.current===request&&identity.current.api===api&&identity.current.id===id;
    try{
      const value=await api.request<OwnerQuestion>(path+'/reply',{method:'POST',signal:request.signal,body:JSON.stringify(body)});
      if(!current())return;
      setAccepted({api,id,value});edit({draft:'',choiceId:undefined,reopened:false,pending:undefined});pending.current=undefined;
      resources(api).invalidate(key=>key.startsWith('/api/owner-questions')||key.startsWith('/api/work-activity')||key.startsWith('/api/materials'));
    }catch(e){if(current()){
      setError(e instanceof ApiError&&e.status===409&&e.code==='conflict'?moteText('这个问题已更新，请查看最新内容后再回答。'):errorMessage(e));
      if(e instanceof ApiError&&[401,403,404,409,410].includes(e.status)){pending.current=undefined;edit({pending:undefined});setAccepted(undefined);detail.refresh();}
    }}finally{if(current()){setBusy(false);controller.current=null;}}
  }
  async function openFollowup(){
    if(!question||question.state!=='answered'||workController.current)return;
    const request=new AbortController(),workId=question.workId,revision=question.revision;workController.current=request;setWorkBusy(true);setWorkError('');
    const current=()=>!request.signal.aborted&&workController.current===request&&identity.current.api===api&&identity.current.id===id&&latestQuestion.current?.revision===revision&&latestQuestion.current?.state==='answered'&&latestQuestion.current?.workId===workId;
    try{const work=await api.request<{id:string}>('/api/work-activity/'+encodeURIComponent(workId),{signal:request.signal});
      if(!current())return;
      if(typeof work.id!=='string'||work.id!==workId)throw new Error(moteText('后续活动暂不可读取，请稍后重试。'));
      window.location.hash='#/activity?'+new URLSearchParams({work:work.id});
    }catch(e){if(current())setWorkError(errorMessage(e));}
    finally{if(current()){workController.current=null;setWorkBusy(false);}}
  }
  const evidence=question?.evidence??[];
  return <section className="conversation-content owner-question-conversation owner-question-final" aria-label={moteText('补充资料对话')} aria-busy={busy||detail.loading}>
    <ConversationHeading plain={standalone} title={question?.title||moteText('需要你补充')} description={moteText('补充后，仅继续处理这份资料')}/>
    {detail.loading&&!question&&<p role="status">{moteText('正在打开对话…')}</p>}
    {Boolean(error||detail.error)&&<p className="notice error" role="alert">{error||errorMessage(detail.error)} <button className="text-button" disabled={busy} onClick={detail.refresh}>{moteText('刷新')}</button></p>}
    {question&&<>
      <div className="owner-question-status">{stateLabel(question.state)}{standalone&&<> · <QuestionSource api={api} reference={question.materialRef}/></>}</div>
      {question.reason&&!standalone&&<p className="owner-question-reason">{question.reason}</p>}
      {(evidence.length>0||question.materialRef)&&<details className="owner-question-evidence"><summary>{moteText(question.state==='obsolete'?'当时引用的片段':'相关原文')}</summary>{standalone&&question.reason&&<p className="owner-question-reason">{question.reason}</p>}{evidence.map(item=><div key={item.id}><blockquote className="owner-question-quote">{item.quote}</blockquote>{item.ref&&<button className="text-button" type="button" onClick={()=>onOpen(item.ref!)}>{moteText('查看原始记录')}<ArrowRight size={14}/></button>}</div>)}{question.materialRef&&<button className="text-button" type="button" onClick={()=>onOpen(question.materialRef!)}>{moteText('打开来源资料')}<ArrowRight size={14}/></button>}</details>}
      <div className="owner-question-dialogue" aria-live="polite">
        {(question.messages.length?question.messages:question.prompt.trim()?[{role:'assistant' as const,text:question.prompt,createdAt:question.createdAt}]:[]).map((message,index)=><article className={'owner-question-message '+message.role} key={index}><span className="owner-question-role">{message.role==='user'?moteText('你'):'Mote'}</span><p>{message.text}</p></article>)}
      </div>
      {busy&&<div className="owner-question-notice" role="status"><LoaderCircle className="spin" size={17}/>{moteText('正在提交，等待回执')}</div>}
      {question.outcome&&<p className="owner-question-notice" role="status">{question.outcome}</p>}
      {question.state==='answered'&&<div className="owner-question-notice" role="status"><strong>{moteText('回答已记录')}</strong><p>{moteText('回答已记录，后续处理状态请查看活动；成果审核完成后才会保存。')}</p></div>}
      {question.state==='deferred'&&<p className="owner-question-notice" role="status">{moteText('已放到稍后处理，其他工作继续；回来后仍可回答。')}</p>}
      {question.state==='closed'&&<p className="owner-question-notice" role="status">{moteText('已保留资料和不确定性，本次不再追问。')}</p>}
      {question.state==='obsolete'&&<div className="owner-question-notice" role="status"><strong>{moteText('这个问题已失效')}</strong><p>{moteText('来源或处理版本已变化，这个问题不再接受回答。')}</p></div>}
      {question.state==='closed'&&!reopened&&<div className="owner-question-actions"><button className="button subtle" type="button" onClick={()=>setReopened(true)}>{moteText('我有新信息了')}</button></div>}
      {showComposer&&<form className="owner-question-form" onSubmit={event=>{event.preventDefault();void reply('answer');}}>
        <div className="owner-question-choices">{question.choices.map(choice=><button type="button" className="button subtle" key={choice.id} disabled={!canReply} aria-pressed={choiceId===choice.id} onClick={()=>{setChoiceId(choice.id);setDraft(choice.answer);}}>{choice.label}</button>)}</div>
        <label><span>{moteText('补充你知道的信息')}</span><textarea aria-label={moteText('回复补充问题')} placeholder={moteText('补充你知道的信息，也可以选择上面的回答。')} value={draft} onChange={event=>{setDraft(event.target.value);setChoiceId(undefined);}} disabled={!canReply} maxLength={6000} rows={4}/></label>
        <div className="owner-question-actions"><button className="button primary" type="submit" disabled={!canReply||!draft.trim()} aria-label={moteText('回答并继续')}>{moteText('回答并继续')}</button><button className="text-button" type="button" disabled={!canReply} onClick={()=>void reply('defer')}>{moteText('稍后再说')}</button><button className="text-button" type="button" disabled={!canReply} onClick={()=>void reply('unknown')}>{moteText('我也不知道')}</button></div>
      </form>}
      {question.state==='answered'&&<div className="owner-question-followup"><button type="button" className="button subtle" disabled={workBusy} onClick={()=>void openFollowup()}>{workBusy?<LoaderCircle className="spin" size={17}/>:null}{moteText(workError?'重试':'查看后续处理')}</button>{workError&&<div className="notice error" role="alert"><p>{moteText('后续活动暂不可读取，请稍后重试。')}</p><p>{workError}</p><a className="text-button" href="#/activity">{moteText('查看活动')}</a></div>}</div>}
    </>}
  </section>;
}
