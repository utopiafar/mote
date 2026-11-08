import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {useForegroundResources} from '../../useForegroundResources';

const path='/api/model-authorization';
type Authority={revision:number;state:'off'|'on';excludedSourceIds:string[]};
type View={authorization:Authority};
type Action='on'|'off'|'stop'|'exclude';

export function AutomaticProcessing({api}:{api:Api}){
 const active=useRef(api);active.current=api;
 const authority=useResource<View>(api,path,5000),sources=useResource<{items:{id:string;name:string}[]}>(api,'/api/sources'),devices=useResource<{items:{deviceId:string;deviceName:string}[]}>(api,'/api/devices');
 useForegroundResources(api,[path,'/api/sources','/api/devices']);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const sending=useRef(false);
 useEffect(()=>{sending.current=false;setBusy(false);setError('');},[api]);
 const current=authority.data?.authorization,failure=authority.error??sources.error??devices.error;
 const ready=Boolean(current)&&failure===undefined;
 const sourceOptions=[...new Map([...(sources.data?.items??[]),...(devices.data?.items??[]).map(value=>({id:'device:'+value.deviceId,name:value.deviceName})),{id:'mote.conversations',name:moteText('已提交对话')}].map(value=>[value.id,value])).values()];
 for(const id of current?.excludedSourceIds??[])if(!sourceOptions.some(value=>value.id===id))sourceOptions.push({id,name:id});
 async function command(action:Action,excludedSourceIds?:string[]){
  if(!current||sending.current)return;
  sending.current=true;setBusy(true);setError('');
  try{
   await api.request(path+'/commands',{method:'POST',body:JSON.stringify({revision:current.revision,operationId:crypto.randomUUID(),action,...(action==='exclude'?{excludedSourceIds}:{})})});
   if(active.current!==api)return;
   authority.refresh();
  }catch(cause){if(active.current===api){setError(errorMessage(cause));authority.refresh();}}
  finally{if(active.current===api){sending.current=false;setBusy(false);}}
 }
 const exclude=(sourceId:string,excluded:boolean)=>command('exclude',excluded?[...new Set([...current!.excludedSourceIds,sourceId])]:current!.excludedSourceIds.filter(id=>id!==sourceId));
 return <section className="automatic-processing-control" aria-label={moteText('自动处理新资料')} aria-busy={busy}>
  <div className="automatic-control-main"><div><h2>{moteText('自动处理新资料')}</h2>{!current&&<p role="status">{moteText(failure!==undefined?'暂不可用':'正在读取…')}</p>}</div><button type="button" role="switch" aria-checked={current?.state==='on'} aria-label={moteText('自动处理新资料')} className={'button '+(current?.state==='on'?'':'primary')} disabled={!ready||busy} onClick={()=>void command(current?.state==='on'?'off':'on')}>{current?.state==='on'?moteText('已开启'):moteText('已关闭')}</button></div>
  {(error||failure!==undefined)&&<div><p role="alert">{moteText('操作未完成，请重试')}</p><details><summary>{moteText('技术详情')}</summary><pre>{error||errorMessage(failure)}</pre></details></div>}
  {current&&<fieldset className="automatic-source-options" disabled={busy}><legend>{moteText('来源排除')}</legend>{sourceOptions.map(source=><label key={source.id}><input type="checkbox" checked={current.excludedSourceIds.includes(source.id)} onChange={event=>void exclude(source.id,event.target.checked)}/><span>{source.name}{sourceOptions.some(other=>other.id!==source.id&&other.name===source.name)&&<small>{source.id}</small>}</span></label>)}</fieldset>}
  <details className="automatic-control-more"><summary>{moteText('更多')}</summary><button type="button" className="text-button" disabled={!ready||busy} onClick={()=>void command('stop')}>{moteText('立即停止全部自动任务')}</button></details>
 </section>;
}
