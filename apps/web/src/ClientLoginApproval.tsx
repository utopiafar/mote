import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {createApi} from './api';
import {errorMessage} from './api';
export function ClientLoginApproval({id,api,done}:{id:string;api:ReturnType<typeof createApi>;done:()=>void}){
  const [name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let current=true;void api.request<{deviceName:string}>(`/api/login/requests/${id}`).then(value=>{if(current)setName(value.deviceName);}).catch(e=>{if(current)setError(errorMessage(e));});return()=>{current=false;};},[id,api]);
  return <section className="panel" role="region" aria-label={moteText('客户端登录')}>
    <p>{moteText('允许「{0}」登录并使用所有中央功能。',name||'…')}</p>
    {error&&<p role="alert">{error}</p>}
    <button className="button primary" disabled={!name||busy} onClick={()=>{setBusy(true);void api.request(`/api/login/requests/${id}/approve`,{method:'POST',body:'{}'}).then(done).catch(e=>setError(errorMessage(e))).finally(()=>setBusy(false));}}>{moteText('继续登录客户端')}</button>
  </section>;
}
