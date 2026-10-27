import {recordingBindingText,recordingSyncText} from './recording-status';
import {moteText} from '@mote/shared/i18n';
import { ArrowRight, FileText, FolderInput, Link2, Mail, Mic, Monitor, Plus } from 'lucide-react';
import type { RecordingStatus } from '@mote/shared';
import type { Api } from './api';
import { errorMessage } from './api';
import { DiscoveryLink, DiscoveryProvider, discoveryAvailabilityText, useDiscoveryState } from './DiscoveryLink';
import { resolveDiscoveryTarget } from './discovery-availability';
import { useResource } from './useResource';
import type { Page } from './navigation';
const recorderNames: Record<string, string> = { feishu: "飞书录音 / 妙记", dingtalk: "钉钉录音 / 闪记" };
export function SourceCatalog({ api, onPage }: {
    api: Api;
    onPage: (page: Page) => void;
}) {
    const discovery = useDiscoveryState(api);
    // ConnectorRegistry mounts its status transport globally; it does not publish HTTP route capabilities.
    const recordingTarget={pageId:'recordings',href:'#/connections/recordings'};
    const recordingAvailability=resolveDiscoveryTarget(recordingTarget,discovery);
    const registry = useResource<Record<string, RecordingStatus>>(api, recordingAvailability.state==='available'?'/api/connectors/status':null);
    const recorders = Object.entries(registry.data ?? {}).filter(([,status]) => status?.category === 'recordings' && typeof status.provider==='string');
    const cards = [
        { title: moteText("手机与电脑"), body: moteText("连接 Android / Mac 等设备，汇集你在本机选择的屏幕、文件和记录。"), note: moteText("先从官方发布页安装客户端；采集与隐私范围在本机设置。"), target: {pageId:'deviceConnections',href:'#/connections/pair'}, icon: Monitor },
        { title: moteText("Coding Agent 会话"), body: moteText("汇集本机 Claude Code、Codex 或 Kimi 的编码对话，已发布正文统一进入资料库。"), note: moteText("先安装并连接 Mac 客户端，在客户端「来源 → 连接 Coding Agent」选择实际存在的 Agent 与采集范围。这里打开说明和同步状态。"), action: moteText("查看客户端接入与同步状态"), target: {pageId:'archive',collectionId:'coding-status',href:'#/library?view=coding-status',requires:['http:GET:/api/coding/uploads']}, icon: Monitor },
        { title: moteText("导入文件"), body: moteText("文件、ZIP、文件夹和服务器目录；保留原件，再解析成可找回的资料。"), note: moteText("可靠且无歧义的解析结果自动保存；其余先确认。"), target: {pageId:'imports',href:'#/library/import'}, icon: FolderInput },
        { title: moteText("飞书文档与日历"), body: moteText("自动发现你创建、编辑或打开的文档，归档正文、版本与活动线索；也可持续跟踪指定范围。"), note: moteText("中央节点只读同步，默认回溯 30 天、每 15 分钟检查。与录音授权分开。"), target: {pageId:'lark',href:'#/connections/lark'}, icon: FileText },
        { title: moteText("Gmail 邮件"), body: moteText("同步邮件正文、发件人和时间，附件保留名称与引用。"), note: moteText("只读接入；先准备 Google OAuth 配置。"), target: {pageId:'sources',href:'#/connections?setup=gmail'}, icon: Mail },
        { title: 'Google Calendar', body: moteText("选择允许读取的日历，由中央节点定期同步安排。"), note: moteText("只读接入；与 Mote 行动建议写入日历分开。"), target: {pageId:'sources',href:'#/connections?setup=google'}, icon: Monitor },
        { title: moteText("MCP 资料服务"), body: moteText("从服务列出的可读资源中，选择一次导入到 Mote。"), note: moteText("填写地址后选择资源，不自动调用外部写入工具。"), target: {pageId:'sources',href:'#/connections?setup=mcp'}, icon: Link2 },
        { title: moteText("外部文件 / NAS 引用"), body: moteText("只保存原件位置、标题与时间；正文仍在外部来源。"), note: moteText("想分析正文时，在可访问原件的客户端保存快照。"), target: {pageId:'sources',href:'#/connections?setup=reference'}, icon: Link2 },
    ];
    return <DiscoveryProvider state={discovery}><div className="discovery-source-catalog"><div className="page-heading split-heading"><div><div className="eyebrow">{moteText("只连接你选择的内容")}</div><h1>{moteText("新增数据源")}</h1><p>{moteText("先选资料从哪里来。每个来源都会说明授权、同步范围和保存方式。")}</p></div><DiscoveryLink target={{pageId:'sources',href:'#/connections'}} className="button subtle" arrow>{moteText("管理已接入来源")}</DiscoveryLink></div>
    <section aria-label={moteText("录音数据源")}><div className="section-heading"><div><h2>{moteText("录音与转写")}</h2><p>{moteText("照常用录音笔；厂商上传并转写后，Mote 归档已有内容。")}</p></div><Mic size={23}/></div>{recordingAvailability.state!=='available' && <p role="status">{discoveryAvailabilityText(recordingAvailability.state)}</p>}{registry.error !== undefined && <p role="alert">{errorMessage(registry.error)}</p>}{registry.loading && !registry.data && <p role="status">{moteText("正在读取录音来源…")}</p>}<div className="discovery-source-grid">{recorders.map(([statusKey,status]) => <RecorderCard key={statusKey} statusKey={statusKey} status={status}/>)}</div></section>
    <section aria-label={moteText("其他数据源")}><div className="section-heading"><h2>{moteText("设备、文件与在线资料")}</h2><Plus size={22}/></div><div className="discovery-source-grid">{cards.map(card => <DiscoveryLink key={card.title} className="panel discovery-source-card" disabledAs="div" target={card.target}><card.icon size={24}/><h3>{card.title}</h3><p>{card.body}</p><small>{card.note}</small><span className="discovery-card-action">{card.action || moteText("打开设置")}<ArrowRight size={16}/></span></DiscoveryLink>)}</div></section>
    <section className="panel discovery-source-boundary"><h2>{moteText("把 Mote 资料交给其他 Chatbot")}</h2><p>{moteText("这是对外授权。可生成只读 MCP 连接来检索归档；指定来源的写回需另行开启。")}</p><DiscoveryLink target={{pageId:'connections',href:'#/connections/access'}} className="button subtle" arrow>{moteText("管理 Chatbot / MCP 连接")}</DiscoveryLink><DiscoveryLink target={{pageId:'featureGuide',href:'#/guide'}} className="text-button">{moteText("查看所有功能与设置 →")}</DiscoveryLink></section>
  </div></DiscoveryProvider>;
}

/** recordingManifest owns the provider-suffix ID/status key and its matching detail route. */
function RecorderCard({statusKey,status}:{statusKey:string;status:RecordingStatus}){
 const content=<><Mic size={24}/><span className="badge muted">{recordingBindingText(status)}</span><h3>{recorderNames[status.provider]?moteText(recorderNames[status.provider]):status.label??status.provider}</h3><p className="recording-sync-status">{recordingSyncText(status)}</p><p>{moteText('选择首次历史范围和持续同步，归档转写并备份原始音频。')}</p><small>{status.provider==='dingtalk'?moteText('中央节点需 DWS CLI 授权；真实账号适配仍待验证。'):status.provider==='feishu'?moteText('中央节点需 Lark CLI 的妙记读取与媒体导出授权。'):moteText('按此来源说明完成中央账号授权。')}</small><span className="discovery-card-action">{moteText('查看接入与同步')}<ArrowRight size={16}/></span></>;
 const identityMatches=/^[a-z][a-z0-9-]{0,63}$/.test(statusKey)&&statusKey===status.provider+'-recordings';
 if(!identityMatches)return <div className="panel discovery-source-card discovery-link-unavailable" aria-disabled="true">{content}<small className="discovery-availability">{discoveryAvailabilityText('unavailable')}</small></div>;
 return <DiscoveryLink className="panel discovery-source-card" disabledAs="div" target={{pageId:'recordings',href:'#/connections/recordings?provider='+encodeURIComponent(status.provider),requires:[{id:'connector:'+statusKey,version:'1',host:'server'}]}}>{content}</DiscoveryLink>;
}
