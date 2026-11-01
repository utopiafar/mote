import type {Api,Capture} from './api';
import {moteText} from '@mote/shared/i18n';
import {formatEvidenceRef} from '@mote/shared';
import {useResource} from './useResource';
import {useEffect,useRef,useState} from 'react';
import {readOriginTurn,conversationTurnRoute,type OriginTurn} from './conversation-origin';
import {AnswerMarkdown} from './AnswerMarkdown';
export function NoteOrigin({api,capture,onOpen,onSettled}:{api:Api;capture:Capture;onOpen:(ref:string)=>void;onSettled?:(instance:object)=>void}){
 const origin=capture.metadata?.noteOrigin;
 if(!origin||origin.kind==='manual')return null;
 return <section className="note-origin"><h3>{moteText(origin.kind==='conversation'?'引用原文':'分享内容')}</h3>{origin.kind==='conversation'&&origin.conversationId&&origin.messageIds?.length===1?<ConversationOrigin key={capture.id+origin.conversationId+origin.messageIds[0]} api={api} conversationId={origin.conversationId} turnId={origin.messageIds[0]} text={origin.text??''} onOpen={onOpen} onSettled={onSettled}/>:origin.text&&<pre>{origin.text}</pre>}{origin.app&&<small>{origin.app}</small>}{origin.url&&<p><code>{origin.url}</code></p>}</section>;
}
export function ConversationOrigin({api,conversationId,turnId,text,onOpen,onSettled,fallbackText=text}:{api:Api;conversationId:string;turnId:string;text:string;onOpen:(ref:string)=>void;onSettled?:(instance:object)=>void;fallbackText?:string}){
 const [state,setState]=useState<{owner:Api;turn?:OriginTurn;failed?:boolean}>(),[revision,retry]=useState(0);
 const [citationError,setCitationError]=useState(''),pendingCitation=useRef<AbortController|null>(null),instance=useRef({});
 const latest=useRef({api,conversationId,turnId,text,turn:undefined as OriginTurn|undefined,onOpen});
 useEffect(()=>{setCitationError('');return()=>{pendingCitation.current?.abort();pendingCitation.current=null;};},[api,conversationId,turnId,text]);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,reading=false,again=false,hidden=document.hidden;
  setState(undefined);
  function schedule(){clearTimeout(timer);if(!controller.signal.aborted&&!document.hidden)timer=setTimeout(()=>{if(!document.hidden)void read();},5000);}
  async function read(){
   if(controller.signal.aborted)return;
   if(reading){again=true;return;}reading=true;
   try{const turn=await readOriginTurn(api,conversationId,turnId,controller.signal);if(!controller.signal.aborted)setState({owner:api,turn,failed:!turn});}
   catch{if(!controller.signal.aborted)setState({owner:api,failed:true});}
   finally{reading=false;const fresh=again&&!document.hidden;again=false;if(!controller.signal.aborted){if(fresh)void read();else schedule();}}
  }
  function visibility(){if(hidden===document.hidden)return;hidden=document.hidden;clearTimeout(timer);if(hidden)again=false;else void read();}
  document.addEventListener('visibilitychange',visibility);
  void read();return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
 },[api,conversationId,turnId,revision]);
 const current=state?.owner===api?state:undefined,turn=current?.turn;
 useEffect(()=>{if(current)onSettled?.(instance.current);},[current,onSettled]);
 // Only split the preserved snapshot when the exact stable-ID source still matches.
 // Never silently replace a saved quote with a newer answer or infer its roles.
 const matched=turn?.result&&text===turn.question+'\n\n'+turn.result.answer;
 latest.current={api,conversationId,turnId,text,turn,onOpen};
 async function openCitation(id:string){
  pendingCitation.current?.abort();const controller=new AbortController();pendingCitation.current=controller;setCitationError('');
  const matches=(value:OriginTurn|undefined)=>Boolean(value?.result&&text===value.question+'\n\n'+value.result.answer&&value.result.citations.some(citation=>citation.id===id));
  const current=()=>{const value=latest.current;return !controller.signal.aborted&&pendingCitation.current===controller&&value.api===api&&value.conversationId===conversationId&&value.turnId===turnId&&value.text===text&&matches(value.turn);};
  try{
   const availability=await api.request<{id:string;available:boolean}>(`/api/conversations/${encodeURIComponent(conversationId)}/references/${encodeURIComponent(id)}`,{signal:controller.signal});
   if(!current())return;
   if(availability.id!==id||availability.available!==true){setCitationError(moteText('引用不可用'));return;}
   // A reference can remain in another turn of the same conversation. Recheck
   // this exact turn and snapshot before opening the independently readable archive.
   const checked=await readOriginTurn(api,conversationId,turnId,controller.signal);
   if(!current())return;
   if(!matches(checked)){setCitationError(moteText('引用不可用'));return;}
   latest.current.onOpen(formatEvidenceRef('capture',id));
  }catch{if(current())setCitationError(moteText('引用不可用'));}
  finally{if(pendingCitation.current===controller)pendingCitation.current=null;}
 }
 return <>{matched?<><h4>{moteText('用户问题')}</h4><pre>{turn.question}</pre><h4>{moteText('AI 回答')}</h4><div className="quoted-answer-markdown"><AnswerMarkdown answer={turn.result!} onOpen={onOpen} numericCitations readOnly/></div></>:<pre>{fallbackText}</pre>}
 {!current?<p role="status">{moteText('正在读取原始对话…')}</p>:current.failed?<p role="status">{moteText('原始对话或轮次暂不可读，可能已删除、权限已变更或连接中断。已保存的引用未改变。')} <button className="text-button" onClick={()=>retry(value=>value+1)}>{moteText('重试')}</button></p>:<>
 {turn?.evidenceStale&&<p className="notice" role="status">{moteText("这是历史版本，当前资料已更新。")}</p>}
 <a className="text-button" href={conversationTurnRoute(conversationId,turnId)}>{moteText('查看原始对话与轮次')}</a>
 {!matched?<p role="status">{moteText('原始轮次与保存的引用不同；请打开原始对话核对，保存的引用未改变。')}</p>:<nav aria-label={moteText('引用来源')}>{turn.result!.citations.map((cite,index)=><button className="text-button" data-origin-citation={cite.id.toLowerCase()} key={index+':'+cite.id} onClick={()=>void openCitation(cite.id)}>{moteText('查看原文依据')} [{index+1}]</button>)}</nav>}
 {citationError&&<p role="status">{citationError}</p>}
 </>}
 </>;
}
function NoteAttachment({api,id,index,onOpen}:{api:Api;id:string;index:number;onOpen:(ref:string)=>void}){
 const file=useResource<{item:{title:string}}>(api,'/api/files/'+encodeURIComponent(id));
 return <button className="button subtle" onClick={()=>onOpen(formatEvidenceRef('capture',id))}>{file.data?.item.title||`${moteText('查看附件')} ${index+1}`}</button>;
}
export function NoteAttachments({api,capture,onOpen}:{api:Api;capture:Capture;onOpen:(ref:string)=>void}){
 const ids=capture.metadata?.attachments??[];
 return ids.length?<section className="note-attachments" aria-label={moteText('附件')}>{ids.map((id,index)=><NoteAttachment key={id} api={api} id={id} index={index} onOpen={onOpen}/>)}</section>:null;
}
