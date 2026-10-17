import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {createApi} from './api';
import {errorMessage} from './api';
export function ClientLoginApproval({id,api,done}:{id:string;api:ReturnType<typeof createApi>;done:()=>void}){
  const binding=useMemo(()=>({api,id}),[api,id]),current=useRef<typeof binding|undefined>(binding);current.current=binding;
  useLayoutEffect(()=>{current.current=binding;return()=>{if(current.current===binding)current.current=undefined;};},[binding]);
  const [detail,setDetail]=useState<{binding:typeof binding;name:string;purpose:'central'|'device'}>(),[failure,setFailure]=useState<{binding:typeof binding;message:string}>(),[pending,setPending]=useState<typeof binding>();
  const ready=detail?.binding===binding?detail:undefined,error=failure?.binding===binding?failure.message:'',busy=pending===binding;
  useEffect(()=>{let active=true;const controller=new AbortController();void api.request<{deviceName:string;purpose?:'central'|'device'}>(`/api/login/requests/${id}`,{signal:controller.signal}).then(value=>{
    if(typeof value.deviceName!=='string'||!value.deviceName.trim()||value.purpose!==undefined&&!['central','device'].includes(value.purpose))throw Error(moteText('服务返回的操作回执与当前账号不一致。'));
    if(active&&current.current===binding)setDetail({binding,name:value.deviceName,purpose:value.purpose??'device'});
  }).catch(e=>{if(active&&current.current===binding)setFailure({binding,message:errorMessage(e)});});return()=>{active=false;controller.abort();};},[binding,api,id]);
  return <section className="panel" role="region" aria-label={moteText('客户端登录')}>
    <p>{ready?.purpose==='central'?moteText('允许「{0}」登录并使用所有中央功能。',ready.name):moteText('允许「{0}」连接为采集设备。',ready?.name??'…')}</p>
    {error&&<p role="alert">{error}</p>}
    <button className="button primary" disabled={!ready||busy} onClick={()=>{
      if(current.current!==binding||!ready||busy)return;
      setPending(binding);void api.request(`/api/login/requests/${id}/approve`,{method:'POST',body:'{}'}).then(()=>{if(current.current===binding)done();}).catch(e=>{if(current.current===binding)setFailure({binding,message:errorMessage(e)});}).finally(()=>{if(current.current===binding)setPending(undefined);});
    }}>{moteText('继续登录客户端')}</button>
  </section>;
}
