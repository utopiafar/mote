import {commonFailureMessage,httpStatusMessage} from '@mote/shared';
import {sourceLabels} from './Metadata';
import {moteText} from '@mote/shared/i18n';
import {ApiError,dateTime,errorMessage,type Capture} from './api';
import type {HomeRead} from './plugins/home/controller';
export type {FirstDeviceData} from './plugins/home/controller';
type FirstDeviceData=import('./plugins/home/controller').FirstDeviceData;
export function FirstDataFailure({error}:{error:unknown}){
 const text=error instanceof ApiError?(error.code&&commonFailureMessage(error.code,error.status)||httpStatusMessage(error.status)):errorMessage(error);
 return <div className="first-use-failure"><p role="alert">{text}</p><details><summary>{moteText('技术详情')}</summary><pre>{errorMessage(error)}{error instanceof ApiError?'\n'+[error.status,error.code,error.requestId].filter(value=>value!==undefined).join(' · '):''}</pre></details></div>;
}
export function FirstUseHome({data,error,loading,configured,preview,onRefresh,onPage,onOpen}:{data?:FirstDeviceData;error?:unknown;loading:boolean;configured:boolean;preview:HomeRead<Capture>;onRefresh:()=>void;onPage:(page:string)=>void;onOpen:(ref:string)=>void}){
 const sample=data?.candidate;
 const unknown=Boolean(error)||Boolean(data?.windowLimited&&!sample),readable=!unknown&&data?.state==='ready'&&data.originalAvailable&&preview.error===undefined;
 const candidate=!unknown?sample:undefined,connected=Boolean(data?.checkedDevices);
 const title=readable?moteText('已经接住一份资料。'):candidate?moteText('资料已收到，原文暂不可用。'):unknown?moteText('接收结果暂未核实。'):connected?moteText('等待设备送来第一份内容。'):moteText('先连上一台设备。');
 const copy=readable?moteText('打开原文，看看留下的内容。'):candidate?moteText('这次没有取得可读原件，可以稍后刷新或到资料库查看。'):unknown?moteText('目前还不能确认可读原件；已收到的内容不会因此被标成丢失。'):connected?moteText('在手机或 Mac 上记一条，也可以选择已有的采集来源。'):moteText('记录留在设备上，连接后按你选择的设置同步到这里。');
 const refresh=()=>onRefresh();
 const actions=<div className="first-use-actions">{readable&&sample?<button className="button primary" onClick={()=>onOpen('capture:'+sample.id)}>{moteText('查看原文')}</button>:<button className="button primary" disabled={loading} onClick={connected||unknown?refresh:()=>onPage('deviceConnections')}>{connected||unknown?moteText('刷新状态'):moteText('查看连接入口')}</button>}<button className="button subtle" onClick={()=>onPage('archive')}>{moteText('打开资料库')}</button></div>;
 return <section className="central-first-use" data-onboarding-state={error?'error':loading?'loading':data?.state??'unverified'}><div className="first-use-heading"><p className="first-use-kicker">{moteText('我的 Mote')}</p><h2>{title}</h2><p>{copy}</p></div>{candidate?<article className="first-use-record"><small className="first-use-received">{moteText('中央已接收')}</small>{preview.data&&preview.error===undefined&&<h3>{preview.data.windowTitle||preview.data.ocrText?.split('\n')[0]?.slice(0,100)||moteText('原始记录')}</h3>}<div className="first-use-record-meta">{candidate.deviceName} · {sourceLabels[candidate.source]??candidate.source}<p>{moteText('记录于 {0} · 接收于 {1}',dateTime(candidate.capturedAt),dateTime(candidate.receivedAt))}</p></div>{readable&&preview.data?.ocrText&&<pre className="first-use-original">{preview.data.ocrText.slice(0,800)}</pre>}{preview.loading&&!preview.data&&<p role="status">{moteText('正在读取…')}</p>}{actions}</article>:actions}{Boolean(error)&&<FirstDataFailure error={error}/>}{preview.error!==undefined&&<FirstDataFailure error={preview.error}/>}{loading&&<p role="status">{moteText('正在读取采集记录…')}</p>}<div className="first-use-stages">{[[connected,moteText('设备已连接')],[Boolean(candidate),moteText('中央已接收')],[readable,moteText('原文可打开')]].map(([done,label],index)=><span key={String(label)} className={done?'done':''}><i>{done?'✓':index+1}</i>{label}</span>)}</div>{readable&&!configured&&<section className="first-use-later"><h3>{moteText('之后需要时再配置')}</h3><div><span>{moteText('问一问与自动理解')}<small>{moteText('保存原文已经可以使用')}</small></span><button className="text-button" onClick={()=>onPage('settings')}>{moteText('模型与服务')} →</button></div></section>}</section>;
}
