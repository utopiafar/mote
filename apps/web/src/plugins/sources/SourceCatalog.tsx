import {recordingBindingText,recordingSyncText} from '../../recording-status';
import {moteText} from '@mote/shared/i18n';
import { CalendarDays, FileText, FolderInput, Link2, Mail, Mic, Monitor, Package } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {useEffect,useState} from 'react';
import type { LarkStatus, PluginCenterView, PluginSourceContribution, RecordingStatus, SourceConnection } from '@mote/shared';
import type { Api } from '../../api';
import { errorMessage } from '../../api';
import { DiscoveryLink, DiscoveryProvider, discoveryAvailabilityText, useDiscoveryState } from '../../DiscoveryLink';
import { resolveDiscoveryTarget } from '../../discovery-availability';
import { useResource } from '../../useResource';
import {useImportReturnRead} from '../../useImportReturnRead';
import type { Page } from '../../navigation';
import {sourcePlugins,type SourcePlugin} from './registry';
import { Loading } from '../../Loading';
import {useSourceConnectorStyle} from '../../source-connectors-ui';
import {aiAccessHref, connectionsHref} from '../agent-access/routes';
const recorderNames: Record<string, string> = { feishu: "飞书录音 / 妙记", dingtalk: "钉钉录音 / 闪记" };
const contributionIcons: Record<string, LucideIcon> = { link: Link2, mail: Mail, calendar: CalendarDays, file: FileText, package: Package, monitor: Monitor };
const contributionStateLabel = (state: PluginSourceContribution['state']) => ({
  installed: moteText('已安装，待配置'),
  configured: moteText('已配置，待核验'),
  ready: moteText('可连接'),
  enabled: moteText('已启用，待授权'),
  needs_attention: moteText('需要处理'),
}[state]);
export function SourceCatalog({ api, onPage }: {
    api: Api;
    onPage: (page: Page) => void;
}) {
    useSourceConnectorStyle();
    useEffect(()=>{if(document.head.querySelector('link[data-mote-source-final]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('../../source-final.css',import.meta.url).href;link.dataset.moteSourceFinal='true';document.head.append(link);},[]);
    const discovery = useDiscoveryState(api),returnReadReady=useImportReturnRead(api,'/api/features');
    const [choice,setChoice]=useState<{api:Api;recordings:boolean}>();
    const recordings=choice?.api===api&&choice.recordings;
    // Recording settings live in the Library source panel; ConnectorRegistry still owns each provider status.
    const recordingTarget={pageId:'archive',href:'#/library?recordings=1'};
    const recordingAvailability=resolveDiscoveryTarget(recordingTarget,discovery);
    const registry = useResource<Record<string, RecordingStatus|{connected?:boolean;state?:string}>>(api, recordingAvailability.state==='available'?'/api/connectors/status':null);
    const lark = useResource<LarkStatus>(api, '/api/connectors/lark');
    const sourceList = useResource<{items:SourceConnection[]}>(api, '/api/sources');
    const plugins = useResource<PluginCenterView>(api, '/api/plugins');
    const catalog = {...(registry.data??{}),...(lark.data?{lark:lark.data}:{})};
    const recorders = Object.entries(registry.data ?? {}).filter((entry):entry is [string,RecordingStatus]=>Boolean(entry[1]&&'category'in entry[1]&&entry[1].category==='recordings'&&'provider'in entry[1]&&typeof entry[1].provider==='string'));
    const pluginCard=(plugin:SourcePlugin)=>{const entry=plugin.catalog!;return {title:entry.title(),body:entry.body(),state:entry.state({catalog,sources:sourceList.data?.items??[],plugins:plugins.data}),note:entry.note(),target:entry.target,icon:entry.icon};};
    const plugin=(id:string)=>pluginCard(sourcePlugins.find(item=>item.id===id)!);
    const builtinKinds=new Set(sourcePlugins.flatMap(item=>item.kinds));
    const declared=(plugins.data?.sourceContributions??[])
      .filter(entry=>entry.kinds.some(kind=>!builtinKinds.has(kind)))
      .map(entry=>({
        title: entry.title,
        body: entry.body,
        state: contributionStateLabel(entry.state)+(entry.attachToBinding?' · '+moteText('可挂到已有账号绑定'):''),
        note: entry.note,
        target: entry.target,
        icon: contributionIcons[entry.icon]??Package,
      }));
    const cards = [
        { title: moteText("文件与文件夹"), body: moteText("导入原件，或在客户端连接文件夹"),state:moteText("支持多个文件、文件夹和 ZIP 压缩包。"), note: moteText("可安全推进的解析会自动保存；关键缺口需要确认。"), target: {pageId:'imports',href:'#/library/import'}, icon: FolderInput },
        plugin('mote.connector.lark'),
        plugin('mote.connector.gmail'),
        plugin('mote.connector.google-calendar'),
        { title: moteText("外部文件 / NAS 引用"), body: moteText("保存位置与元信息"),state:moteText("保存外部位置"), note: moteText("想分析正文时，在可访问原件的客户端保存快照。"), target: {pageId:'sources',href:'#/connections?setup=reference'}, icon: Link2 },
        plugin('mote.connector.mcp'),
        ...sourcePlugins.filter(item=>item.packageId&&item.catalog).map(pluginCard),
        ...declared,
    ];
    const recorderState=registry.error||registry.loading?moteText('待确认'):recorders.length?recorders.map(([,status])=>(recorderNames[status.provider]?moteText(recorderNames[status.provider]):status.label??status.provider)+' · '+recordingBindingText(status)).join('；'):moteText('尚未绑定账号');
    const renderCard=(card:typeof cards[number])=><article key={card.title} className="source-catalog-entry"><DiscoveryLink className="panel discovery-source-card" disabledAs="div" target={card.target}><card.icon size={22}/><span><h3>{card.title}</h3><p>{card.body}</p><small className="catalog-state">{card.state}</small></span></DiscoveryLink></article>;
    return <DiscoveryProvider state={discovery}>{!returnReadReady&&<Loading/>}<div className="discovery-source-catalog source-catalog-final" data-import-return-ready={returnReadReady} aria-hidden={!returnReadReady||undefined} style={{visibility:returnReadReady?"visible":"hidden"}}>{recordings&&<button className="text-button source-catalog-back" onClick={()=>setChoice({api,recordings:false})}>{moteText('← 返回数据源目录')}</button>}<div className="page-heading split-heading"><h1>{moteText(recordings?'录音与转写':'新建')}</h1>{!recordings&&<DiscoveryLink target={{pageId:'sources',href:connectionsHref}} className="text-button">{moteText('连接')}</DiscoveryLink>}</div>
    {recordings?<section aria-label={moteText("录音数据源")}>{recordingAvailability.state!=='available'&&<p role="status">{discoveryAvailabilityText(recordingAvailability.state)}</p>}{registry.error!==undefined&&<p role="alert">{errorMessage(registry.error)}</p>}{registry.loading&&!registry.data&&<Loading label={moteText('正在读取录音来源…')}/>}<div className="discovery-source-grid source-recorder-choices">{recordingAvailability.state==='available'&&recorders.map(([statusKey,status])=><RecorderCard key={statusKey} statusKey={statusKey} status={status}/>)}</div>{registry.data&&!recorders.length&&<p>{moteText('当前服务未提供此入口')}</p>}{recorders.length>0&&<details className="source-catalog-more"><summary>{moteText('更多')}</summary>{recorders.map(([key,status])=><section key={key}><h3>{recorderNames[status.provider]?moteText(recorderNames[status.provider]):status.label??status.provider}</h3><RecorderHelp status={status}/></section>)}</details>}</section>:<>
    <div className="discovery-source-grid" aria-label={moteText('添加来源')}>{cards.slice(0,2).map(renderCard)}<article className="source-catalog-entry"><button className="panel discovery-source-card" disabled={recordingAvailability.state!=='available'} aria-disabled={recordingAvailability.state!=='available'?true:undefined} onClick={()=>setChoice({api,recordings:true})}><Mic size={22}/><span><h3>{moteText('录音与转写')}</h3><p>{moteText('归档厂商已有的录音与转写')}</p><small className="catalog-state">{recordingAvailability.state==='available'?recorderState:discoveryAvailabilityText(recordingAvailability.state)}</small></span></button></article>{cards.slice(2).map(renderCard)}</div>
    <DiscoveryLink target={{pageId:'connections',href:aiAccessHref()}} className="text-button">{moteText('AI 接入')}</DiscoveryLink>
    <details className="source-catalog-more"><summary>{moteText('接入准备')}</summary>{cards.map(card=><section key={card.title}><h3>{card.title}</h3><p>{card.note}</p></section>)}</details>
    </>}
  </div></DiscoveryProvider>;

}

/** recordingManifest owns the provider-suffix ID/status key and its matching detail route. */
function RecorderCard({statusKey,status}:{statusKey:string;status:RecordingStatus}){
 const binding=recordingBindingText(status),sync=recordingSyncText(status);
 const content=<><h3>{recorderNames[status.provider]?moteText(recorderNames[status.provider]):status.label??status.provider}</h3><small>{binding}{sync!==binding?' · '+sync:''}</small></>;

 const identityMatches=/^[a-z][a-z0-9-]{0,63}$/.test(statusKey)&&statusKey===status.provider+'-recordings';
 if(!identityMatches)return <article className="source-catalog-entry"><div className="panel discovery-source-card discovery-link-unavailable" aria-disabled="true">{content}<small className="discovery-availability">{discoveryAvailabilityText('unavailable')}</small></div></article>;
 return <article className="source-catalog-entry"><DiscoveryLink className="panel discovery-source-card" disabledAs="div" target={{pageId:'archive',href:'#/library?recordings='+encodeURIComponent(status.provider),requires:[{id:'connector:'+statusKey,version:'1',host:'server'}]}}>{content}</DiscoveryLink></article>;
}

function RecorderHelp({status}:{status:RecordingStatus}){return <><p>{moteText('选择首次历史范围和持续同步，归档转写并备份原始音频。')}</p><p>{status.provider==='dingtalk'?moteText('中央需 DWS CLI 授权；真实账号适配仍待验证。'):status.provider==='feishu'?moteText('中央需 Lark CLI 的妙记读取与媒体导出授权。'):moteText('按此来源说明完成中央账号授权。')}</p></>;}
