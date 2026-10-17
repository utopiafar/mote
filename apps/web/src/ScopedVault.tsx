import {FilesExport} from './FilesExport';
import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {ArrowDownToLine,Info,Unplug} from 'lucide-react';
import {type Api,bytes,dateTime,errorMessage} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {lifecycleReceipt,lifecycleLabel,type LifecycleReceipt} from './lifecycle-receipt';
import {ScopedPortableImport} from './ScopedPortableImport';
const selectedExport=()=>{const id=new URLSearchParams(window.location.hash.split('?')[1]??'').get('export');return id&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)?id:undefined;};

export function ScopedVault({api,embedded,disconnect}:{api:Api;embedded?:boolean;disconnect:()=>void}){
 const connection=api.connection;if(connection?.mode!=='web')throw Error(moteText('服务返回的操作回执与当前账号不一致。'));
 const userId=connection.userId;
 const [id,setId]=useState<string|undefined>(selectedExport),[cursor,setCursor]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const owner=useRef(api),alive=useRef(true),intent=useRef<string|undefined>(undefined);owner.current=api;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[api]);
 useEffect(()=>{const changed=()=>setId(selectedExport());window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[api]);
 const select=(value:string)=>{setId(value);const [route,search]=window.location.hash.split('?'),query=new URLSearchParams(search);query.set('export',value);window.history.replaceState(window.history.state,'',route+'?'+query);window.dispatchEvent(new window.Event('mote:workspace-state'));};
 const live=(value:Api)=>alive.current&&owner.current===value,base='/api/portable/exports';
 const page=useResource<{items:unknown[];nextCursor:string|null}>(api,base+'?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
 const path=id?base+'/'+encodeURIComponent(id):null,selected=useResource<unknown>(api,path);
 let receipt:LifecycleReceipt|undefined,items:LifecycleReceipt[]=[],readError=selected.error??page.error;
 try{if(selected.data)receipt=lifecycleReceipt(api,selected.data,'export',userId,id);items=(page.data?.items??[]).map(value=>lifecycleReceipt(api,value,'export',userId));}catch(e){readError=e;}
 useEffect(()=>path&&receipt?.state==='working'?resources(api).get(path).poll(1000):undefined,[api,path,receipt?.state]);
 useEffect(()=>{if(receipt&&['completed','cancelled','failed'].includes(receipt.state))resources(api).invalidate(key=>key.startsWith(base+'?'));},[api,receipt?.id,receipt?.state]);
 const refresh=()=>resources(api).invalidate(key=>key.startsWith(base));
 async function start(){if(busy||!live(api))return;const fixed=api;intent.current??=crypto.randomUUID();const operationId=intent.current;setBusy(true);setError('');try{const result=lifecycleReceipt(fixed,await fixed.request(base,{method:'POST',body:JSON.stringify({operationId})}),'export',userId,operationId);if(!live(fixed))return;select(result.id);intent.current=undefined;refresh();}catch(e){if(live(fixed))setError(errorMessage(e));}finally{if(live(fixed))setBusy(false);}}
 async function control(action:'retry'|'cancel'){if(!receipt||busy||!live(api))return;const fixed=api,target=receipt.id;setBusy(true);setError('');try{lifecycleReceipt(fixed,await fixed.request(base+'/'+target+'/'+action,{method:'POST',body:'{}'}),'export',userId,target);if(live(fixed))refresh();}catch(e){if(live(fixed))setError(errorMessage(e));}finally{if(live(fixed))setBusy(false);}}
 async function download(){if(!receipt||receipt.state!=='completed'||busy||!live(api))return;const fixed=api,expected=receipt;setBusy(true);setError('');try{
  const response=await fixed.raw(base+'/'+expected.id+'/content'),buffer=await response.arrayBuffer();if(!live(fixed))return;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),v=>v.toString(16).padStart(2,'0')).join('');if(!live(fixed))return;
  if(response.status!==200||response.headers.get('content-type')!==expected.contentType||response.headers.get('etag')!=='"'+expected.sha256+'"'||buffer.byteLength!==expected.bytes||digest!==expected.sha256)throw Error(moteText('归档校验失败，请重新读取操作回执。'));
  const url=URL.createObjectURL(new Blob([buffer],{type:expected.contentType})),anchor=document.createElement('a');anchor.href=url;anchor.download=expected.filename!;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){if(live(fixed))setError(errorMessage(e));}finally{if(live(fixed))setBusy(false);}}
 return <><div className={embedded?'section-heading':'page-heading'}>{embedded?<h2>{moteText('数据与备份')}</h2>:<h1>{moteText('数据与备份')}</h1>}<p>{moteText('知道留下了什么、存在哪里，也随时保留迁移的自由。')}</p></div>
 {(error||readError!==undefined)&&<p className="error-banner" role="alert">{error||errorMessage(readError)}</p>}
 <section className="panel storage-panel"><h2>{moteText('存储概况')}</h2><a className="button subtle" href="#/system">{moteText('查看运行状态与空间')}</a></section>
 <section className="panel transfer-panel"><div className="section-heading"><h2>{moteText('导入与导出')}</h2><ArrowDownToLine size={21}/></div><div className="transfer-action transfer-export"><div><h3>{moteText('导出资料')}</h3><p>{moteText('仅导出当前账号的规范资料；凭据、执行授权和实例备份不包含在内。')}</p></div><button className="button subtle" disabled={busy} onClick={()=>void start()}>{moteText('导出')}</button></div>
 {receipt&&<section className="portable-export-receipt" aria-live="polite"><h3>{lifecycleLabel(receipt.state)}</h3><p>{dateTime(receipt.createdAt)}</p><p>{moteText('当前阶段：{0}',receipt.phase)}</p>{receipt.error&&<p role="status">{receipt.error}</p>}<details><summary>{moteText('覆盖范围与处理状态')}</summary>{receipt.domains.map(domain=><p key={domain.domain}>{domain.domain} · {domain.state}</p>)}</details>{receipt.state==='completed'&&<><p>{bytes(receipt.bytes!)}</p><button className="button" disabled={busy} onClick={()=>void download()}>{moteText('下载归档')}</button></>}{receipt.state==='failed'&&<button className="button" disabled={busy} onClick={()=>void control('retry')}>{moteText('重试')}</button>}{receipt.state!=='cancelled'&&<button className="button subtle" disabled={busy} onClick={()=>void control('cancel')}>{moteText('取消归档')}</button>}</section>}
 <div className="connection-list">{items.map(item=><button className="button subtle" key={item.id} onClick={()=>select(item.id)}>{dateTime(item.createdAt)} · {lifecycleLabel(item.state)}</button>)}</div><div className="processing-actions">{cursor&&<button className="button" onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}{page.data?.nextCursor&&<button className="button" onClick={()=>setCursor(page.data!.nextCursor!)}>{moteText('下一页')}</button>}<button className="button subtle" onClick={refresh}>{moteText('刷新')}</button></div>
 <FilesExport key={JSON.stringify(api.connection)} api={api}/>
 <ScopedPortableImport api={api}/>
 <div className="backup-note"><Info size={16}/><div><strong>{moteText('大资料库适合使用离线备份')}</strong><p>{moteText('实例备份与恢复由中央节点停机命令执行。')}</p><code>npm run backup -- --help</code></div></div></section>
 <section className="panel node-settings"><div><strong>{moteText('当前服务（中央节点）')}</strong><p>{connection.origin}</p></div><button className="button subtle" onClick={disconnect}><Unplug size={15}/>{moteText('退出登录')}</button></section></>;
}
