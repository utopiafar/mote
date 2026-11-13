import React,{useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {queryScopeSchema,type QueryScope} from '@mote/shared';
import type {Api} from '../../api';
import {MatterDetail} from './MatterDetail';
import {RoutineDetail} from './RoutineDetail';
import {CommitmentDetail} from './CommitmentDetail';
import {AssistantList,kindTitle} from './lists';
import {BackgroundStatus,all,useAssistantCapabilities} from './common';

const owners=new WeakMap<Api,number>();let nextOwner=0;
export function AssistantMatters({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
 if(!owners.has(api))owners.set(api,++nextOwner);
 return <AssistantMattersContent key={owners.get(api)} api={api} onOpen={onOpen}/>;
}
function AssistantMattersContent({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}){
 const [hash,setHash]=useState(()=>window.location.hash),can=useAssistantCapabilities(api);
 useEffect(()=>{const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('../../assistant-matters.css?no-inline',import.meta.url).href;document.head.append(link);return()=>link.remove();},[]);
 useEffect(()=>{const sync=()=>setHash(window.location.hash);window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
 const query=new URLSearchParams(hash.split('?')[1]),kind=query.has('matter')?'matter':query.has('routine')?'routine':query.has('commitment')?'commitment':undefined,id=kind?query.get(kind):undefined;
 let scope:QueryScope=all;
 if(query.has('scope')){
  try{scope=queryScopeSchema.parse(JSON.parse(query.get('scope')!));}
  catch{return <p role="alert">{moteText('输入格式无效，请检查必填项和取值范围。')}</p>;}
 }
 const selectionKey=JSON.stringify([kind,id,scope]);
 const tab=query.get('tab')==='routine'?'routine':query.get('tab')==='commitment'?'commitment':'matter',back=query.get('returnTo');
 const returnTo=back&&/^#\/assistant\/matters(?:\?[^#]{0,4000})?$/.test(back)?back:'#/assistant/matters?'+new URLSearchParams({scope:JSON.stringify(scope)});
 return <div className="assistant-matters"><header><h1>{moteText('事项与规则')}</h1>{kind?<a className="text-button" href={returnTo}>← {moteText('返回')}</a>:<nav className="segmented-nav" aria-label={moteText('事项与规则')}>
  {(['matter','commitment','routine'] as const).map(value=><a key={value} aria-current={tab===value?'page':undefined} href={'#/assistant/matters?'+new URLSearchParams({tab:value,scope:JSON.stringify(scope)})}>{kindTitle(value)}</a>)}</nav>}</header>
  {kind&&id?(kind==='matter'?<MatterDetail key={selectionKey} api={api} id={id} scope={scope} onOpen={onOpen}/>:kind==='routine'?<RoutineDetail key={selectionKey} api={api} id={id} scope={scope}/>:<CommitmentDetail key={selectionKey} api={api} id={id} scope={scope} onOpen={onOpen}/>):
   can('http:GET:/api/assistant/'+(tab==='matter'?'matters':tab==='routine'?'routines':'commitments'))?<AssistantList key={JSON.stringify([tab,scope])} api={api} kind={tab} scope={scope}/>:<p role="status">{moteText('当前服务未提供此入口')}</p>}
  <BackgroundStatus api={api}/>
 </div>;
}
