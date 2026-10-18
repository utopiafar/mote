import {moteText} from '@mote/shared/i18n';
import {useEffect,useRef,useState} from 'react';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {failureMessage} from './failure-message';
type UpdateView={currentVersion:string;latestVersion:string|null;verified:boolean;state:'idle'|'checking'|'ready'|'error';error?:string};
declare const __MOTE_WEB_VERSION__: string;
export function SoftwareUpdate({api}:{api:Api}){return api.connection?.mode==='web'?<ScopedSoftwareUpdate key={JSON.stringify(api.connection)} api={api}/>:<LegacySoftwareUpdate api={api}/>;}
function ScopedSoftwareUpdate({api}:{api:Api}){
 const read=useResource<UpdateView>(api,'/api/software-update'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 async function check(){if(busy||!active.current)return;setBusy(true);setError('');try{await api.request('/api/software-update/check',{method:'POST',body:'{}'});if(active.current)read.refresh();}catch(e){if(active.current)setError(errorMessage(e));}finally{if(active.current)setBusy(false);}}
 const value=read.error===undefined?read.data:undefined;
 return <section className="panel software-update" aria-labelledby="software-update-title"><div className="section-heading"><h2 id="software-update-title">{moteText('软件版本与更新')}</h2></div><p>{moteText('网页版本')} <strong>{__MOTE_WEB_VERSION__}</strong></p><p>{moteText('当前版本')} <strong>{value?.currentVersion??'—'}</strong></p><button className="button subtle" disabled={busy||read.loading&&!value} onClick={()=>void check()}>{moteText('检查更新')}</button>
 {value?.currentVersion&&value.currentVersion!==__MOTE_WEB_VERSION__&&<p className="notice error" role="alert">{moteText('网页与服务版本不一致，请重新构建网页并刷新页面。')}</p>}{value?.state==='ready'&&value.verified&&<p role="status">{moteText('已核验发布版本：{0}',value.latestVersion??'—')}</p>}{value?.error&&<p role="alert">{failureMessage(value.error)}</p>}{(error||read.error!==undefined)&&<p role="alert">{error||errorMessage(read.error)}</p>}
 <p>{moteText('此处仅检查签名发布信息，不会执行更新或回滚。')}</p><a className="button" href="https://github.com/utopiafar/mote/releases" target="_blank" rel="noreferrer">{moteText('下载 DEV 安装包')}</a></section>;
}
function LegacySoftwareUpdate({api}:{api:Api}) {
  const [version,setVersion]=useState(''),[error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();void api.request<{currentVersion:string}>('/api/software-update',{signal:c.signal}).then(v=>setVersion(v.currentVersion)).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();},[api]);
  return <section className="panel software-update" aria-labelledby="software-update-title"><div className="section-heading"><h2 id="software-update-title">{moteText('软件版本与更新')}</h2><span className="badge">DEV</span></div><p>{moteText('网页版本')} <strong>{__MOTE_WEB_VERSION__}</strong></p><p>{moteText('当前版本')} <strong>{version||'—'}</strong></p>{version&&version!==__MOTE_WEB_VERSION__&&<p className="notice error" role="alert">{moteText('网页与服务版本不一致，请重新构建网页并刷新页面。')}</p>}{error&&<p role="alert">{error}</p>}<p>{moteText('开发阶段仅提供 DEV 安装包，请到 GitHub 下载并手动安装。')}</p><p>{moteText('中央服务从源码部署，升级前先备份。当前不提供应用内自动更新。')}</p><a className="button" href="https://github.com/utopiafar/mote/releases" target="_blank" rel="noreferrer">{moteText('下载 DEV 安装包')}</a></section>;
}
