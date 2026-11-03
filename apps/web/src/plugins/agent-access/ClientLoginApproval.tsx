import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {createApi} from '../../api';
import {errorMessage} from '../../api';

export type ClientLoginOutcome='approved'|'rejected';

/** One browser approval panel for one exact login request. Both decisions use
 * that request's ID and a late response from a replaced request can never
 * publish over the current panel or navigate it. */
export function ClientLoginApproval({id,api,done}:{id:string;api:ReturnType<typeof createApi>;done:(outcome:ClientLoginOutcome)=>void}){
  const binding=useMemo(()=>({api,id}),[api,id]),current=useRef<typeof binding|undefined>(binding);current.current=binding;
  useLayoutEffect(()=>{current.current=binding;return()=>{if(current.current===binding)current.current=undefined;};},[binding]);
  const [detail,setDetail]=useState<{binding:typeof binding;name:string}>(),[failure,setFailure]=useState<{binding:typeof binding;message:string}>(),[pending,setPending]=useState<typeof binding>();
  const ready=detail?.binding===binding?detail:undefined,error=failure?.binding===binding?failure.message:'',busy=pending===binding;
  useEffect(()=>{let active=true;const controller=new AbortController();void api.request<{deviceName:string}>(`/api/login/requests/${id}`,{signal:controller.signal}).then(value=>{
    if(typeof value.deviceName!=='string'||!value.deviceName.trim())throw Error(moteText('中央响应格式无效，请刷新后重试。'));
    if(active&&current.current===binding)setDetail({binding,name:value.deviceName});
  }).catch(e=>{if(active&&current.current===binding)setFailure({binding,message:errorMessage(e)});});return()=>{active=false;controller.abort();};},[binding,api,id]);
  const resolve=(action:'approve'|'reject')=>{
    if(current.current!==binding||!ready||busy)return;
    setPending(binding);
    void api.request(`/api/login/requests/${id}/${action}`,{method:'POST',body:'{}'}).then(()=>{if(current.current===binding)done(action==='approve'?'approved':'rejected');}).catch(e=>{if(current.current===binding)setFailure({binding,message:errorMessage(e)});}).finally(()=>{if(current.current===binding)setPending(undefined);});
  };
  return <section className="panel" role="region" aria-label={moteText('客户端登录')}>
    <p>{moteText('允许「{0}」登录并使用所有中央功能。',ready?.name??'…')}</p>
    {error&&<p role="alert">{error}</p>}
    <div className="processing-actions"><button className="button primary" disabled={!ready||busy} onClick={()=>resolve('approve')}>{moteText('继续登录客户端')}</button><button className="button" disabled={!ready||busy} onClick={()=>resolve('reject')}>{moteText('拒绝这次登录')}</button></div>
  </section>;
}
