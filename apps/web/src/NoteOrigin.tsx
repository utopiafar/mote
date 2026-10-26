import type {Api,Capture} from './api';
import {moteText} from '@mote/shared/i18n';
import {formatEvidenceRef} from '@mote/shared';
import {useResource} from './useResource';
import {useEffect,useState} from 'react';
import {readOriginTurn,conversationTurnRoute,type OriginTurn} from './conversation-origin';
export function NoteOrigin({api,capture,onOpen}:{api:Api;capture:Capture;onOpen:(ref:string)=>void}){
 const origin=capture.metadata?.noteOrigin;
 if(!origin||origin.kind==='manual')return null;
 return <section className="note-origin"><h3>{moteText(origin.kind==='conversation'?'引用原文':'分享内容')}</h3>{origin.kind==='conversation'&&origin.conversationId&&origin.messageIds?.length===1?<ConversationOrigin key={capture.id+origin.conversationId+origin.messageIds[0]} api={api} conversationId={origin.conversationId} turnId={origin.messageIds[0]} text={origin.text??''} onOpen={onOpen}/>:origin.text&&<pre>{origin.text}</pre>}{origin.app&&<small>{origin.app}</small>}{origin.url&&<p><code>{origin.url}</code></p>}</section>;
}
function ConversationOrigin({api,conversationId,turnId,text,onOpen}:{api:Api;conversationId:string;turnId:string;text:string;onOpen:(ref:string)=>void}){
 const [state,setState]=useState<{owner:Api;turn?:OriginTurn;failed?:boolean}>(),[revision,retry]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  setState(undefined);
  async function read(){
   try{const turn=await readOriginTurn(api,conversationId,turnId,controller.signal);if(!controller.signal.aborted)setState({owner:api,turn,failed:!turn});}
   catch{if(!controller.signal.aborted)setState({owner:api,failed:true});}
   if(!controller.signal.aborted)timer=setTimeout(()=>void read(),5000);
  }
  void read();return()=>{controller.abort();clearTimeout(timer);};
 },[api,conversationId,turnId,revision]);
 const current=state?.owner===api?state:undefined,turn=current?.turn;
 // Only split the preserved snapshot when the exact stable-ID source still matches.
 // Never silently replace a saved quote with a newer answer or infer its roles.
 const matched=turn?.result&&text===turn.question+'\n\n'+turn.result.answer;
 return <>{matched?<><h4>{moteText('用户问题')}</h4><pre>{turn.question}</pre><h4>{moteText('AI 回答')}</h4><pre>{turn.result!.answer}</pre></>:<pre>{text}</pre>}
 {!current?<p role="status">{moteText('正在读取原始对话…')}</p>:current.failed?<p role="status">{moteText('原始对话或轮次暂不可读，可能已删除、权限已变更或连接中断。已保存的引用未改变。')} <button className="text-button" onClick={()=>retry(value=>value+1)}>{moteText('重试')}</button></p>:<>
 <a className="text-button" href={conversationTurnRoute(conversationId,turnId)}>{moteText('查看原始对话与轮次')}</a>
 {!matched?<p role="status">{moteText('原始轮次与保存的引用不同；请打开原始对话核对，保存的引用未改变。')}</p>:<nav aria-label={moteText('引用来源')}>{turn.result!.citations.map((cite,index)=><button className="text-button" key={index+':'+cite.id} onClick={()=>onOpen(formatEvidenceRef('capture',cite.id))}>{moteText('查看原文依据')} [{index+1}]</button>)}</nav>}
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
