import {moteText} from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import {type Api,errorMessage} from './api';
declare const __MOTE_WEB_VERSION__: string;
export function SoftwareUpdate({api}:{api:Api}) {
  const [version,setVersion]=useState(''),[error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();void api.request<{currentVersion:string}>('/api/software-update',{signal:c.signal}).then(v=>setVersion(v.currentVersion)).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();},[api]);
  return <section className="panel software-update" aria-labelledby="software-update-title"><div className="section-heading"><h2 id="software-update-title">{moteText('软件版本与更新')}</h2><span className="badge">DEV</span></div><p>{moteText('网页版本')} <strong>{__MOTE_WEB_VERSION__}</strong></p><p>{moteText('当前版本')} <strong>{version||'—'}</strong></p>{version&&version!==__MOTE_WEB_VERSION__&&<p className="notice error" role="alert">{moteText('网页与服务版本不一致，请重新构建网页并刷新页面。')}</p>}{error&&<p role="alert">{error}</p>}<p>{moteText('开发阶段仅提供 DEV 安装包，请到 GitHub 下载并手动安装。')}</p><p>{moteText('中央服务从源码部署，升级前先备份。当前不提供应用内自动更新。')}</p><a className="button" href="https://github.com/utopiafar/mote/releases" target="_blank" rel="noreferrer">{moteText('下载 DEV 安装包')}</a></section>;
}
