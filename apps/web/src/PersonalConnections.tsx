import {useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {errorMessage,dateTime,type Api} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {DevicePairing} from './DevicePairing';

type Credential={id:string;kind:'web'|'client'|'mcp-read'|'mcp-write';label?:string;createdAt:number;expiresAt:number;revokedAt:number|null};
export function PersonalConnections({api}:{api:Api}){
 const inventory=useResource<{items:Credential[]}>(api,'/api/connections'),sources=useResource<{items:{id:string;name:string}[]}>(api,'/api/sources');
 const [label,setLabel]=useState(''),[access,setAccess]=useState<'read'|'write'>('read'),[sourceIds,setSourceIds]=useState<string[]>([]),[secret,setSecret]=useState<{id:string;config:unknown}>(),[revoking,setRevoking]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const running=useRef(false),refresh=()=>resources(api).invalidate(key=>key==='/api/connections');
 async function run(action:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setError('');try{await action();refresh();}catch(e){setError(errorMessage(e));}finally{running.current=false;setBusy(false);}}
 return <section className="panel panel-pad connections-panel"><div className="section-heading"><div><h1>{moteText('对外授权')}</h1><p>{moteText('专用凭据仅在此次生成时显示。离开页面后仍有效；丢失时可以撤销并重新生成。')}</p></div><button className="button subtle" onClick={refresh}>{moteText('刷新连接')}</button></div>
  {(error||inventory.error!==undefined)&&<p role="alert">{error||errorMessage(inventory.error)}</p>}
  <form onSubmit={e=>{e.preventDefault();void run(async()=>{const grant=await api.request<{token:string;credentialId:string}>('/api/connections/mcp',{method:'POST',body:JSON.stringify({label,access,sourceIds,durationMs:2592000000})});setSecret({id:grant.credentialId,config:{mcpServers:{mote:{type:'http',url:location.origin+'/mcp',headers:{Authorization:'Bearer '+grant.token}}}}});});}}>
   <h2>{moteText('MCP 连接配置')}</h2><label>{moteText('名称')}<input required value={label} onChange={e=>setLabel(e.target.value)}/></label>
   <label>{moteText('访问权限')}<select value={access} onChange={e=>setAccess(e.target.value as 'read'|'write')}><option value="read">{moteText('MCP · 只读资料')}</option><option value="write">{moteText('MCP · 指定来源写入')}</option></select></label>
   <fieldset><legend>{moteText('来源范围')}</legend>{sources.data?.items.map(source=><label key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={e=>setSourceIds(old=>e.target.checked?[...old,source.id]:old.filter(id=>id!==source.id))}/>{source.name}</label>)}</fieldset>
   <p className="fine-print">{access==='read'?moteText('未选择来源时，可读取本人全部来源。'):moteText('写入必须明确选择已有来源。')}</p>
   <button className="button" disabled={busy||(access==='write'&&!sourceIds.length)}>{moteText('生成 MCP 配置')}</button>
  </form>
  {secret&&<div className="connection-mcp"><h3>{moteText('保存此 MCP 配置')}</h3><textarea aria-label="MCP JSON" readOnly value={JSON.stringify(secret.config,null,2)}/><button className="button subtle" onClick={()=>setSecret(undefined)}>{moteText('已保存，隐藏凭据')}</button></div>}
  <h2>{moteText('已授权的连接')}</h2><ul className="connection-list">{inventory.data?.items.map(item=><li key={item.id}><div><strong>{item.label??item.kind}</strong><p>{item.kind} · {dateTime(new Date(item.createdAt).toISOString())}</p>{item.revokedAt!==null&&<span className="badge muted">{moteText('已撤销')}</span>}</div>{item.revokedAt===null&&(revoking===item.id?<div><button className="button danger" disabled={busy} onClick={()=>void run(async()=>{await api.request('/api/connections/'+encodeURIComponent(item.id),{method:'DELETE'});if(secret?.id===item.id)setSecret(undefined);setRevoking('');})}>{moteText('确认撤销')}</button><button className="button" onClick={()=>setRevoking('')}>{moteText('取消')}</button></div>:<button className="button subtle" onClick={()=>setRevoking(item.id)}>{moteText('撤销')}</button>)}</li>)}</ul>
 <DevicePairing api={api}/></section>;
}
