import {ArrowRight,ArrowUpRight} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import {type Api,errorMessage} from './api';
import {version as packageVersion} from '../package.json';
declare const __MOTE_WEB_VERSION__: string;
export function SoftwareUpdate({api}:{api:Api}) {
 const [version,setVersion]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 const webVersion=typeof __MOTE_WEB_VERSION__==='string'?__MOTE_WEB_VERSION__:packageVersion;
 useEffect(()=>{const controller=new AbortController();setVersion('');setError('');setLoading(true);void api.request<{currentVersion:string}>('/api/software-update',{signal:controller.signal}).then(value=>{if(controller.signal.aborted)return;if(typeof value.currentVersion!=='string'||!value.currentVersion.trim())throw Error(moteText('暂未读到版本'));setVersion(value.currentVersion);}).catch(error=>{if(!controller.signal.aborted)setError(errorMessage(error));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[api,revision]);
 return <section className="software-update final-software-update" aria-labelledby="software-update-title"><div className="version-summary"><small>Mote · DEV</small><h2 id="software-update-title">{moteText('个人上下文工作台')}</h2><dl className="web-service-facts"><dt>{moteText('网页版本')}</dt><dd>{webVersion}</dd><dt>{moteText('中央服务')}</dt><dd>{loading?moteText('正在检查…'):version||moteText('暂未读到版本')}</dd></dl>{version&&version!==webVersion&&<p className="notice error" role="alert">{moteText('网页与服务版本不一致，请重新构建网页并刷新页面。')}</p>}{error&&<p role="alert">{error}</p>}<button className="button subtle" disabled={loading} onClick={()=>setRevision(value=>value+1)}>{moteText('重新检查')}</button></div><details className="version-upgrade"><summary>{moteText('升级中央服务')}</summary><p>{moteText('中央服务从源码部署，升级前先备份。当前不提供应用内自动更新。')}</p><a className="text-button" href="#/system/storage">{moteText('备份与导出')}<ArrowRight size={14} aria-hidden="true" style={{verticalAlign:"middle",marginInlineStart:"0.3em"}}/></a><a className="text-button" href="https://github.com/utopiafar/mote/releases" target="_blank" rel="noreferrer">{moteText('下载 DEV 客户端')}<ArrowUpRight size={14} aria-hidden="true" style={{verticalAlign:"middle",marginInlineStart:"0.3em"}}/></a></details></section>;
}
