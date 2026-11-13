import React,{useEffect,useMemo,useState} from 'react';
import {workspaceRequestSchema,workspaceTemplateSchema,workspaceCommandReferenceSchema,workspaceLabels,
  type QueryScope,type WorkspaceRequest,type WorkspaceView} from '@mote/shared';
import {parseUiContribution,strictDataObject} from '@mote/shared/plugin-ui';
import {moteText} from '@mote/shared/i18n';
import {DeclarativeView,DeclarativeViewSession,parseDeclarativeView} from '../plugin-host/declarative-view';
import type {Api} from '../api';
import type {PageProps} from '../features/types';
import {useResource} from '../useResource';
import {Loading} from '../Loading';
import {ErrorNotice} from '../shell-components';

/** Consume the producer's descriptor and spec through the existing strict
 * decoders. Command references must match the descriptor's directory exactly. */
export function decodeWorkspaceView(raw:unknown):WorkspaceView{
  const value=strictDataObject(raw,['request','descriptor','spec','data','commands']);
  const request=workspaceRequestSchema.parse(value.request),descriptor=parseUiContribution(value.descriptor);
  const spec=parseDeclarativeView(value.spec,descriptor),commands=workspaceCommandReferenceSchema.array().max(64).parse(value.commands);
  if(descriptor.kind!=='declarative-view'||descriptor.apiVersion!=='1'||!descriptor.platforms.includes('web')||
    new Set(commands.map(command=>command.id)).size!==commands.length||
    JSON.stringify(descriptor.commands)!==JSON.stringify(commands.map(({id,apiVersion})=>({id,apiVersion}))))throw new Error('Invalid workspace command directory');
  if(!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw new Error('Invalid workspace data');
  return {request,descriptor,spec,data:strictDataObject(value.data,Object.keys(value.data)),commands};
}

export const workspacePath=(request:WorkspaceRequest)=>'/api/assistant/workbench?'+new URLSearchParams({request:JSON.stringify(workspaceRequestSchema.parse(request))});
export const workspaceTranslate=(key:string)=>moteText(workspaceLabels[key]??key);

const stateLabels:Readonly<Record<string,string>>={active:'进行中',paused:'已暂停',archived:'已归档',published:'有效',
  pending_confirmation:'待确认',confirmed:'已确认',completed:'已完成',cancelled:'已取消',
  pending:'待处理',partial:'部分可用',ready:'已就绪',failed:'失败',unsupported:'不支持'};
function displayData(data:Record<string,unknown>):Record<string,unknown>{
  const row=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).map(([key,item])=>[
    key,key==='original'&&typeof item==='boolean'?moteText(item?'打开':'不可用'):
      ['state','extraction','semantic','embedding'].includes(key)&&typeof item==='string'&&stateLabels[item]?moteText(stateLabels[item]):item,
  ]));
  return row(Object.fromEntries(Object.entries(data).map(([key,value])=>[key,Array.isArray(value)?value.map(item=>item&&typeof item==='object'&&!Array.isArray(item)?row(item):item):value])));
}

/** One trusted endpoint, with the exact producer-issued target and revision.
 * The client never interprets an arbitrary URL or command implementation. */
export function workspaceSession(raw:unknown,api:Pick<Api,'request'>){
  const view=decodeWorkspaceView(raw);
  const session=new DeclarativeViewSession(view.descriptor,view.spec,async(command,input)=>{
    const reference=view.commands.find(value=>value.id===command.id&&value.apiVersion===command.apiVersion);
    if(!reference)throw new Error('Undeclared workspace command');
    return api.request('/api/assistant/workbench/commands',{method:'POST',body:JSON.stringify({request:view.request,command:reference,input})});
  });
  return {view,session};
}

export function WorkspaceSurface({value,api,onResult}:{value:unknown;api:Pick<Api,'request'>;onResult?:(ok:boolean,request?:WorkspaceRequest)=>void}){
  const {view,session}=useMemo(()=>workspaceSession(value,api),[value,api]);
  useEffect(()=>{
    const visibility=()=>{if(document.hidden)session.lifetime.suspend();else session.lifetime.show();};
    visibility();document.addEventListener('visibilitychange',visibility);
    return()=>{document.removeEventListener('visibilitychange',visibility);session.lifetime.dispose();};
  },[session]);
  return <DeclarativeView session={session} data={displayData(view.data)} translate={workspaceTranslate} onResult={(_command,ok,result)=>{
    if(!ok){onResult?.(false);return;}
    try{const next=decodeWorkspaceView(result);onResult?.(true,next.request);}catch{onResult?.(false);}
  }}/>;
}

/** The Web wrapper supplies only navigation and the existing generic
 * container. All four layouts and their data come from Central. */
export function AssistantWorkbenchPage({api,range}:Pick<PageProps,'api'|'range'>){
  const [template,setTemplate]=useState<WorkspaceRequest['template']>('project');
  const [target,setTarget]=useState<string>();
  const [commandFailed,setCommandFailed]=useState(false);
  const scope:QueryScope={kind:'all',...range};
  const request:WorkspaceRequest={template,scope,...(target?template==='person'?{personMemoryId:target}:{matterId:target}:{})};
  const path=workspacePath(request),read=useResource<unknown>(api,path,5000,undefined,undefined,true);
  let view:WorkspaceView|undefined,invalid=false;
  if(read.data!==undefined&&read.error===undefined)try{view=decodeWorkspaceView(read.data);}catch{invalid=true;}
  const choices=(view?.data[template==='person'?'memories':'matters']??[]) as {id:string;title:string}[];
  return <section className="card">
    <h2>{moteText('工作台')}</h2>
    <nav className="segmented-nav" aria-label={moteText('工作台')}>{workspaceTemplateSchema.options.map(name=>
      <button key={name} aria-current={template===name?'page':undefined} onClick={()=>{setTemplate(name);setTarget(undefined);setCommandFailed(false);}}>{workspaceTranslate(name)}</button>)}</nav>
    <select aria-label={workspaceTranslate(template)} value={target??''} onChange={event=>{setTarget(event.target.value||undefined);setCommandFailed(false);}}>
      <option value="">{moteText('当前范围')}</option>
      {target&&!choices.some(item=>item.id===target)&&<option value={target}>{moteText('当前选择')}</option>}
      {choices.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
    </select>
    <p>{workspaceTranslate('limited')}</p>
    {commandFailed&&<p role="status">{workspaceTranslate('changed')}</p>}
    {read.loading&&read.data===undefined?<Loading/>:read.error!==undefined||invalid?<ErrorNotice text={workspaceTranslate('failed')} retry={read.refresh}/>:
      view&&<WorkspaceSurface value={view} api={api} onResult={(ok,next)=>{
        setCommandFailed(!ok);if(ok&&next)setTarget(next.personMemoryId??next.matterId);read.refresh();
      }}/>}
  </section>;
}
