import {InstanceControls} from './InstanceControls';
import {ScopedConfiguration} from './ScopedConfiguration';
import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {isWebConnection,type Api,errorMessage,dateTime} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {changeWebAuthentication} from './web-auth';
import {AccountDeletion} from './AccountDeletion';

type Account={userId:string;username:string;administrator:boolean;disabled:boolean;createdAt:number;deletionId?:string};
export function AccountSettings({api,disconnect,onLogin}:{api:Api;disconnect:()=>void;onLogin:()=>void}){
 const connection=api.connection;
 const [currentPassword,setCurrentPassword]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 if(!connection||!isWebConnection(connection))return null;
 return <><section className="panel session-settings" aria-label={moteText('当前账号')}>
  <h2>{moteText('当前账号')}</h2><p><strong>{connection.username}</strong>{connection.administrator?' · '+moteText('管理员'):''}</p><p>{connection.origin}</p>
  {connection.expiresAt&&<p>{moteText('登录会话有效期')} · {dateTime(new Date(connection.expiresAt).toISOString())}</p>}
  <div className="action-toolbar"><button className="button" onClick={onLogin}>{moteText('切换账号')}</button><button className="button subtle" onClick={disconnect}>{moteText('退出登录')}</button></div>
  <details><summary>{moteText('修改密码')}</summary><form onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setError('');void changeWebAuthentication(()=>api.request('/api/auth/password',{method:'POST',body:JSON.stringify({currentPassword,password})}),false).catch(e=>setError(errorMessage(e))).finally(()=>setBusy(false));}}>
   <label>{moteText('当前密码')}<input type="password" autoComplete="current-password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)} required/></label>
   <label>{moteText('新密码')}<input type="password" minLength={12} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>
   {error&&<p role="alert">{error}</p>}<button className="button" disabled={busy}>{moteText('修改密码')}</button>
  </form></details>
 </section>{connection.administrator&&<><AccountAdministration api={api}/><InstanceControls api={api}/><details className="panel panel-pad"><summary>{moteText('共享模型资源')}</summary><ScopedConfiguration api={api} administrator/></details></>}</>;
}
export function AccountAdministration({api}:{api:Api}){return <OwnedAccountAdministration key={JSON.stringify(api.connection)} api={api}/>;}
function OwnedAccountAdministration({api}:{api:Api}){
 const accounts=useResource<{items:Account[]}>(api,'/api/admin/accounts');
 const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[administrator,setAdministrator]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[target,setTarget]=useState<Account>();
 const [replacement,setReplacement]=useState('');
 async function mutate(path:string,method:string,body:unknown){if(busy)return;setBusy(true);setError('');try{await api.request(path,{method,body:JSON.stringify(body)});resources(api).invalidate(key=>key==='/api/admin/accounts');setPassword('');setReplacement('');setTarget(undefined);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 return <section className="panel panel-pad" aria-label={moteText('账号管理')}><h2>{moteText('账号管理')}</h2>
  {(error||accounts.error!==undefined)&&<p role="alert">{error||errorMessage(accounts.error)}</p>}
  <form onSubmit={event=>{event.preventDefault();void mutate('/api/admin/accounts','POST',{username,password,administrator});}}>
   <label>{moteText('用户名')}<input aria-label={moteText('新账号用户名')} autoComplete="off" value={username} onChange={e=>setUsername(e.target.value)} required/></label>
   <label>{moteText('初始密码')}<input type="password" autoComplete="new-password" minLength={12} value={password} onChange={e=>setPassword(e.target.value)} required/></label>
   <label><input type="checkbox" checked={administrator} onChange={e=>setAdministrator(e.target.checked)}/>{moteText('管理员')}</label><button className="button" disabled={busy}>{moteText('创建账号')}</button>
  </form>
  <ul className="connection-list">{accounts.data?.items.map(account=><li key={account.userId}><div><strong>{account.username}</strong> · {account.administrator?moteText('管理员'):moteText('普通用户')} · {account.disabled?moteText('已禁用'):moteText('已启用')}</div>{!account.deletionId&&<><button className="button subtle" disabled={busy} onClick={()=>void mutate('/api/admin/accounts/'+encodeURIComponent(account.userId),'PATCH',{disabled:!account.disabled})}>{account.disabled?moteText('启用账号'):moteText('禁用账号')}</button><button className="button subtle" disabled={busy} onClick={()=>setTarget(account)}>{moteText('重置密码')}</button></>}<AccountDeletion api={api} account={account}/></li>)}</ul>
  {target&&<form role="region" aria-label={moteText('重置密码')} onSubmit={e=>{e.preventDefault();void mutate('/api/admin/accounts/'+encodeURIComponent(target.userId)+'/password','POST',{password:replacement});}}><strong>{target.username}</strong><label>{moteText('新密码')}<input type="password" minLength={12} autoComplete="new-password" value={replacement} onChange={e=>setReplacement(e.target.value)} required/></label><button className="button" disabled={busy}>{moteText('确认重置')}</button><button type="button" className="button" onClick={()=>setTarget(undefined)}>{moteText('取消')}</button></form>}
 </section>;
}
