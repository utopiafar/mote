import {useEffect,useRef,useState,type ReactNode} from 'react';
import {X} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {PluginCenterView,PluginReleasePreview} from '@mote/shared';
import {ApiError,errorMessage,type Api} from '../../api';
import {resources} from '../../resource-cache';
import {containDialogFocus} from '../../dialog-focus';
import {capabilityLabel,hasRequiresBuild,blockerLabel} from './plugin-center-presentation';

const pluginsPath='/api/plugins';

function Modal({title,close,opener,children,busy}:{title:string;close:()=>void;opener:HTMLElement|null;children:ReactNode;busy:boolean}){
 const ref=useRef<HTMLElement>(null);
 useEffect(()=>ref.current?containDialogFocus(ref.current,opener):undefined,[opener]);
 return <div className="modal-backdrop plugin-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)close();}} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.stopPropagation();close();}}}>
  <section className="modal plugin-modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
   <div className="section-heading"><h2>{title}</h2><button className="icon-button" aria-label={moteText('关闭详情')} disabled={busy} onClick={close}><X size={20}/></button></div>
   {children}
  </section>
 </div>;
}

/** Advanced owner path for trusted GitHub releases. Official catalog stays on
 * 自动记忆与插件; this surface is Settings → 运行与诊断 only. */
export function TrustedGithubPluginInstall({api}:{api:Api}){
 const [repository,setRepository]=useState('');
 const [tag,setTag]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [preview,setPreview]=useState<PluginReleasePreview>();
 const [revision,setRevision]=useState(1);
 const [supported,setSupported]=useState(true);
 const opener=useRef<HTMLElement|null>(null);
 const identity=useRef(api);
 identity.current=api;
 useEffect(()=>{
  let cancelled=false;
  void api.request<PluginCenterView>(pluginsPath).then(view=>{
   if(cancelled||identity.current!==api)return;
   setRevision(view.revision);setSupported(view.installation.supported);
  }).catch(cause=>{if(!cancelled&&identity.current===api)setError(errorMessage(cause));});
  return()=>{cancelled=true;};
 },[api]);
 async function resolve(){
  if(!repository.trim()||busy)return;
  const owner=api;setBusy(true);setError('');opener.current=document.activeElement as HTMLElement;
  try{
   const value=await owner.request<PluginReleasePreview>('/api/plugins/resolve',{method:'POST',body:JSON.stringify({repository:repository.trim(),...(tag.trim()?{tag:tag.trim()}:{})})});
   if(identity.current===owner)setPreview(value);
  }catch(cause){if(identity.current===owner)setError(errorMessage(cause));}
  finally{if(identity.current===owner)setBusy(false);}
 }
 async function install(){
  if(!preview||busy)return;
  const owner=api;setBusy(true);setError('');
  try{
   await owner.request(pluginsPath+'/install',{method:'POST',body:JSON.stringify({previewId:preview.id,expectedRevision:revision,operationId:crypto.randomUUID()})});
   if(identity.current===owner){resources(owner).invalidate(key=>key===pluginsPath||key.startsWith('/api/plugin'));setPreview(undefined);setRepository('');setTag('');}
  }catch(cause){
   if(identity.current!==owner)return;
   setError(errorMessage(cause));
   if(cause instanceof ApiError&&cause.status===409){
    try{const view=await owner.request<PluginCenterView>(pluginsPath);if(identity.current===owner)setRevision(view.revision);}catch{/* keep prior revision */}
   }
  }finally{if(identity.current===owner)setBusy(false);}
 }
 return <section className="plugin-advanced plugin-discovery trusted-github-plugin-install" aria-label={moteText('从 GitHub 添加其他可信插件')}>
  <h2>{moteText('从 GitHub 添加其他可信插件')}</h2>
  <p>{moteText('读取兼容发布包，预览版本、能力与访问范围后安装。GitHub 数据连接器仍在资料来源中管理。')}{' '}{moteText('官方目录在「自动记忆与插件」。')}</p>
  {!supported&&<p className="notice">{moteText('当前节点不支持在线安装。')}</p>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  <form className="plugin-fields" onSubmit={event=>{event.preventDefault();void resolve();}}>
   <label className="preference-field">{moteText('GitHub 仓库')}<input value={repository} onChange={event=>setRepository(event.target.value)} placeholder="https://github.com/owner/repository" required disabled={busy||!supported}/></label>
   <label className="preference-field">{moteText('发布标签（可选）')}<input value={tag} onChange={event=>setTag(event.target.value)} disabled={busy||!supported}/></label>
   <div className="plugin-footer"><button className="button primary" disabled={busy||!supported||!repository.trim()}>{busy?moteText('正在解析…'):moteText('预览发布包')}</button></div>
  </form>
  {preview&&<Modal title={moteText('安装预览')} close={()=>!busy&&setPreview(undefined)} busy={busy} opener={opener.current}>
   <h3>{preview.name} · {preview.version}</h3>
   <dl className="plugin-facts">
    <div><dt>{moteText('来源')}</dt><dd>{preview.source.repository}</dd></div>
    <div><dt>{moteText('固定版本')}</dt><dd>{preview.source.tag} · {preview.source.commit}</dd></div>
    <div><dt>{moteText('完整性摘要')}</dt><dd>{preview.source.digest}</dd></div>
    <div><dt>{moteText('运行位置')}</dt><dd>{preview.runtime==='worker'?moteText('中央 Worker'):moteText('独立服务')}{preview.restartRequired?' · '+moteText('安装后需重启'):''}</dd></div>
    <div><dt>{moteText('访问声明')}</dt><dd>{preview.access.length?preview.access.join(' · '):moteText('没有访问声明')}</dd></div>
    <div><dt>{moteText('依赖')}</dt><dd>{preview.dependencies.join(' · ')||moteText('无声明依赖')}</dd></div>
   </dl>
   <ul className="plugin-capabilities">{preview.capabilities.map(item=><li key={item.id}><span>{item.id}</span><span className={'badge '+(item.state==='verified'?'green':'muted')}>{capabilityLabel(item.state)}</span>{item.reason&&<small>{blockerLabel(item.reason)}</small>}</li>)}</ul>
   {hasRequiresBuild(preview.capabilities.map(item=>item.reason??''))&&<p className="notice" role="status">{moteText('需要重新构建（requires-build）')}</p>}
   <p className="notice">{moteText('可信插件代码拥有中央宿主权限；访问声明不是沙箱隔离。安装完成后仍需配置、启用与绑定。')}</p>
   {preview.issues.map((issue,index)=><p className="notice" key={index}>{issue}</p>)}
   <div className="plugin-footer">
    <button className="button primary" disabled={busy||!preview.installable||!supported} onClick={()=>void install()}>{busy?moteText('正在安装…'):moteText('安装此版本')}</button>
    <button className="button subtle" disabled={busy} onClick={()=>setPreview(undefined)}>{moteText('取消')}</button>
   </div>
  </Modal>}
 </section>;
}
