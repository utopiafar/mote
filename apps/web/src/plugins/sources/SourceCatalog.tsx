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
    useEffect(()=>{if(document.head.querySelector('link[data-mote-source-final]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('../../source-final.css',import.meta.url).href;link.dataset.moteSourceFinal='true';document.head.append(link);},[]);
    const discovery = useDiscoveryState(api),returnReadReady=useImportReturnRead(api,'/api/features');
    const [choice,setChoice]=useState<{api:Api;recordings:boolean}>();
    const recordings=choice?.api===api&&choice.recordings;
    // ConnectorRegistry mounts its status transport globally; it does not publish HTTP route capabilities.
    const recordingTarget={pageId:'recordings',href:'#/connections/recordings'};
    const recordingAvailability=resolveDiscoveryTarget(recordingTarget,discovery);
    const registry = useResource<Record<string, RecordingStatus|{connected?:boolean;state?:string}>>(api, recordingAvailability.state==='available'?'/api/connectors/status':null);
    const lark = useResource<LarkStatus>(api, '/api/connectors/lark');
    const sourceList = useResource<{items:SourceConnection[]}>(api, '/api/sources');
    const plugins = useResource<PluginCenterView>(api, '/api/plugins');
    const catalog = {...(registry.data??{}),...(lark.data?{lark:lark.data}:{})};
    const recorders = Object.entries(registry.data ?? {}).filter((entry):entry is [string,RecordingStatus]=>Boolean(entry[1]&&'category'in entry[1]&&entry[1].category==='recordings'&&'provider'in entry[1]&&typeof entry[1].provider==='string'));
    const pluginCard=(plugin:SourcePlugin)=>{const entry=plugin.catalog!;return {title:entry.title(),body:entry.body(),state:entry.state({catalog,sources:sourceList.data?.items??[]}),note:entry.note(),target:entry.target,icon:entry.icon};};
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
        { title: moteText("手机与电脑"), body: moteText("连接 Mac 或 Android 客户端"), state:moteText("在客户端管理"), note: moteText("先从官方发布页安装客户端；采集与隐私范围在本机设置。"), target: {pageId:'deviceConnections',href:'#/connections/pair'}, icon: Monitor },
        { title: moteText("Coding Agent 会话"), body: moteText("在客户端选择 Codex、Claude Code 等已有会话"),state:moteText("通过 Mac 客户端接入"), note: moteText("先安装并连接 Mac 客户端，在客户端「来源 → 连接 Coding Agent」选择实际存在的 Agent 与采集范围。这里打开说明和同步状态。"), action: moteText("查看客户端接入与同步状态"), target: {pageId:'archive',collectionId:'coding-status',href:'#/library?view=coding-status',requires:['http:GET:/api/coding/uploads']}, icon: Monitor },
        { title: moteText("文件与文件夹"), body: moteText("导入原件，或在客户端连接文件夹"),state:moteText("支持多个文件、文件夹和 ZIP 压缩包。"), note: moteText("可靠且无歧义的解析结果自动保存；其余先确认。"), target: {pageId:'imports',href:'#/library/import'}, icon: FolderInput },
        plugin('mote.connector.lark'),
        plugin('mote.connector.gmail'),
        plugin('mote.connector.google-calendar'),
        { title: moteText("外部文件 / NAS 引用"), body: moteText("保存位置与元信息"),state:moteText("保存外部位置"), note: moteText("想分析正文时，在可访问原件的客户端保存快照。"), target: {pageId:'sources',href:'#/connections?setup=reference'}, icon: Link2 },
        plugin('mote.connector.mcp'),
        ...declared,
    ];
    const recorderState=registry.error||registry.loading?moteText('待确认'):recorders.length?recorders.map(([,status])=>(recorderNames[status.provider]?moteText(recorderNames[status.provider]):status.label??status.provider)+' · '+recordingBindingText(status)).join('；'):moteText('尚未绑定账号');
    const renderCard=(card:typeof cards[number])=><article key={card.title} className="source-catalog-entry"><DiscoveryLink className="panel discovery-source-card" disabledAs="div" target={card.target}><card.icon size={22}/><span><h3>{card.title}</h3><p>{card.body}</p><small className="catalog-state">{card.state}</small></span></DiscoveryLink></article>;
    return <DiscoveryProvider state={discovery}>{!returnReadReady&&<p role="status">{moteText("正在读取…")}</p>}<div className="discovery-source-catalog source-catalog-final" data-import-return-ready={returnReadReady} aria-hidden={!returnReadReady||undefined} style={{visibility:returnReadReady?"visible":"hidden"}}>{recordings&&<button className="text-button source-catalog-back" onClick={()=>setChoice({api,recordings:false})}>{moteText('← 返回数据源目录')}</button>}<div className="page-heading split-heading"><h1>{moteText(recordings?'录音与转写':'添加来源')}</h1>{!recordings&&<DiscoveryLink target={{pageId:'sources',href:'#/connections'}} className="text-button" arrow>{moteText("管理已接入来源")}</DiscoveryLink>}</div>
    {recordings?<section aria-label={moteText("录音数据源")}>{recordingAvailability.state!=='available'&&<p role="status">{discoveryAvailabilityText(recordingAvailability.state)}</p>}{registry.error!==undefined&&<p role="alert">{errorMessage(registry.error)}</p>}{registry.loading&&!registry.data&&<p role="status">{moteText("正在读取录音来源…")}</p>}<div className="discovery-source-grid source-recorder-choices">{recordingAvailability.state==='available'&&recorders.map(([statusKey,status])=><RecorderCard key={statusKey} statusKey={statusKey} status={status}/>)}</div>{registry.data&&!recorders.length&&<p>{moteText('当前服务未提供此入口')}</p>}{recorders.length>0&&<details className="source-catalog-more"><summary>{moteText('更多')}</summary>{recorders.map(([key,status])=><section key={key}><h3>{recorderNames[status.provider]?moteText(recorderNames[status.provider]):status.label??status.provider}</h3><RecorderHelp status={status}/></section>)}</details>}</section>:<>
    <div className="discovery-source-grid" aria-label={moteText('添加来源')}>{cards.slice(0,4).map(renderCard)}<article className="source-catalog-entry"><button className="panel discovery-source-card" disabled={recordingAvailability.state!=='available'} aria-disabled={recordingAvailability.state!=='available'?true:undefined} onClick={()=>setChoice({api,recordings:true})}><Mic size={22}/><span><h3>{moteText('录音与转写')}</h3><p>{moteText('归档厂商已有的录音与转写')}</p><small className="catalog-state">{recordingAvailability.state==='available'?recorderState:discoveryAvailabilityText(recordingAvailability.state)}</small></span></button></article>{cards.slice(4).map(renderCard)}</div>
    <details className="source-catalog-more"><summary>{moteText('更多')}</summary><section className="discovery-source-boundary"><h2>{moteText("把 Mote 资料交给其他 Chatbot")}</h2><p>{moteText("这是对外授权。可生成只读 MCP 连接来检索归档；指定来源的写回需另行开启。")}</p><DiscoveryLink target={{pageId:'connections',href:'#/connections/access'}} className="text-button" arrow>{moteText("管理 Chatbot / MCP 连接")}</DiscoveryLink><DiscoveryLink target={{pageId:'featureGuide',href:'#/guide'}} className="text-button">{moteText("查看所有功能与设置 →")}</DiscoveryLink></section><details><summary>{moteText('接入准备')}</summary>{cards.map(card=><section key={card.title}><h3>{card.title}</h3><p>{card.note}</p></section>)}</details></details>
    </>}
  </div></DiscoveryProvider>;

}

/** recordingManifest owns the provider-suffix ID/status key and its matching detail route. */
function RecorderCard({statusKey,status}:{statusKey:string;status:RecordingStatus}){
 const binding=recordingBindingText(status),sync=recordingSyncText(status);
 const content=<><h3>{recorderNames[status.provider]?moteText(recorderNames[status.provider]):status.label??status.provider}</h3><small>{binding}{sync!==binding?' · '+sync:''}</small></>;

 const identityMatches=/^[a-z][a-z0-9-]{0,63}$/.test(statusKey)&&statusKey===status.provider+'-recordings';
 if(!identityMatches)return <article className="source-catalog-entry"><div className="panel discovery-source-card discovery-link-unavailable" aria-disabled="true">{content}<small className="discovery-availability">{discoveryAvailabilityText('unavailable')}</small></div></article>;
 return <article className="source-catalog-entry"><DiscoveryLink className="panel discovery-source-card" disabledAs="div" target={{pageId:'recordings',href:'#/connections/recordings?provider='+encodeURIComponent(status.provider),requires:[{id:'connector:'+statusKey,version:'1',host:'server'}]}}>{content}</DiscoveryLink></article>;
}

function RecorderHelp({status}:{status:RecordingStatus}){return <><p>{moteText('选择首次历史范围和持续同步，归档转写并备份原始音频。')}</p><p>{status.provider==='dingtalk'?moteText('中央需 DWS CLI 授权；真实账号适配仍待验证。'):status.provider==='feishu'?moteText('中央需 Lark CLI 的妙记读取与媒体导出授权。'):moteText('按此来源说明完成中央账号授权。')}</p></>;}
