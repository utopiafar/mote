import { moteText } from '@mote/shared/i18n';
import {useSyncExternalStore} from 'react';
import { ArrowLeft, ArrowRight, ChevronRight, Settings2, SlidersHorizontal, Puzzle, Archive, BarChart3, HardDrive, Wrench, Bot, CircleHelp } from 'lucide-react';
const settingsIcons:Record<string,typeof Settings2>={settings:SlidersHorizontal,extensions:Puzzle,vault:Archive,usage:BarChart3,statistics:HardDrive,developer:Wrench,agentView:Bot,help:CircleHelp};
import { webFeatures } from './features/registry';
import {AppearanceSelector} from './AppearanceSelector';
import { LanguageSelector } from './LanguageSelector';
import { pageLabels, sectionFor, sections, type Page } from './navigation';
export function primaryDestination(page: Page) {
    if(page==='featureGuide'||page==='search')return 'overview';
    if(page==='connections')return 'connections';
    if(page==='coding')return 'archive';
    const section = sectionFor(page);
    if (section === 'library')
        return 'archive';
    if (section === 'connections')
        return 'sources';
    if (page === 'processing')
        return 'activity';
    if (page === 'actions')
        return 'overview';
    return ['overview', 'archive', 'ask', 'activity', 'sources'].includes(page) ? page : 'about';
}
/** Settings keep their task controls; the complete feature directory remains a discovery surface. */
export function isSettingsContext(page: Page) {
    return page !== 'featureGuide' && (primaryDestination(page) === 'about' || ['lark', 'recordings'].includes(page));
}
export function parentDestination(page:Page):Page|undefined {
    if(page==='featureGuide'||page==='search')return 'overview';
    if(page==='coding')return 'archive';
    const section=sectionFor(page);
    if(section==='library'&&page!=='archive')return 'archive';
    if(section==='connections'&&page!=='sources')return 'sources';
    if(page==='settings')return;
    if(page==='processing')return 'activity';
    if(page==='actions')return 'overview';
    if(primaryDestination(page)==='about'&&page!=='about')return 'about';
}
/** Section tools are visible links, not a form control, so the current tool reads as navigation. */
function ToolLinks({ label, tools, page, onPage }: { label: string; tools: string[]; page: Page; onPage: (page: Page) => void }) {
    return <nav className="workspace-tool-links" aria-label={label}>{tools.map(id => <button key={id} type="button" className="text-button" aria-current={page === id ? 'page' : undefined} onClick={() => onPage(id)}>{pageLabels[id]}</button>)}</nav>;
}
export function WorkspaceNavigation({ page, onPage }: {
    page: Page;
    onPage: (page: Page) => void;
}) {
    const section = sectionFor(page);
    if (section === 'library') {
        const tools = sections.library.filter(id => id !== 'archive');
        return <div className="workspace-context">
      {page !== 'archive' && <button className="back-link" aria-label={moteText('返回{0}', pageLabels.archive)} onClick={() => onPage('archive')}><ArrowLeft size={16}/>{moteText('返回上级')}</button>}
      <ToolLinks label={moteText('资料库工具')} tools={tools} page={page} onPage={onPage}/>
    </div>;
    }
    if (section === 'connections' && page !== 'connections') {
        const tools = sections.connections.filter(id => id !== 'sources' && id !== 'connections');
        return <div className="workspace-context">
      {page !== 'sources' && <button className="back-link" aria-label={moteText('返回{0}', pageLabels.sources)} onClick={() => onPage('sources')}><ArrowLeft size={16}/>{moteText('返回上级')}</button>}
      <ToolLinks label={moteText('来源与连接')} tools={tools} page={page} onPage={onPage}/>
    </div>;
    }
    // The models page owns its nested categories and their single parent control.
    if (page === 'settings')
        return null;
    if (page === 'featureGuide')
        return <button className="back-link workspace-back" aria-label={moteText('返回{0}',pageLabels.overview)} onClick={()=>onPage('overview')}><ArrowLeft size={16}/>{moteText('返回{0}',pageLabels.overview)}</button>;
    const parent=parentDestination(page);
    return parent?<button className="back-link workspace-back" aria-label={moteText('返回{0}',pageLabels[parent])} onClick={()=>onPage(parent)}><ArrowLeft size={16}/>{moteText('返回上级')}</button>:null;
}
export function SettingsLanding({ onPage }: {
    onPage: (page: Page) => void;
}) {
    useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
    const cards = [
        { id: 'settings', title: moteText("模型与服务"), description: moteText("连接模型服务，为问答、导入、记忆和洞察分配模型；调整图片、文件与语音处理。") },
        { id: 'extensions', title: moteText("自动记忆与插件"), description: moteText("暂停 / 恢复自动记忆、查看当前方案；预览并安装可信插件。") },
        { id: 'vault', title: moteText("存储、加密与备份"), description: moteText("查看保存方式；导出或恢复归档，管理内容加密与检索索引。") },
        { id: 'usage', title: moteText("用量与费用"), description: moteText("查看各功能的实际模型用量、费用记录与估算边界。") },
        { id: 'statistics', title: moteText("运行状态与空间"), description: moteText("按文件类型和最后修改日期查看中央节点的实际磁盘占用。") },
        { id: 'developer', title: moteText("诊断与更新"), description: moteText("查看脱敏日志和版本，导出问题诊断；检查高级部署配置。") },
        { id: 'agentView', title: moteText("Agent 能看到什么"), description: moteText("查看可访问资料目录、首次上下文与实际读取记录。") },
        { id: 'help', title: moteText("帮助与反馈"), description: moteText("排查连接、授权和处理问题，提交问题反馈。") },
    ];
    const known = new Set(cards.map(card => card.id));
    const extra = webFeatures.pages().filter(entry => (entry.section === 'system' || !entry.section) && !known.has(entry.id) && !new Set(['overview', 'ask', 'actions', 'activity', 'processing', 'about', 'featureGuide','search','coding']).has(entry.id));
    return <section className="settings-destinations"><div className="settings-toolbar"><LanguageSelector /><AppearanceSelector /><button className="text-button" onClick={() => onPage('featureGuide')}>{moteText("全部功能")}<ArrowRight size={15}/></button></div><p className="settings-scope">{moteText("采集范围在设备本机；中央节点负责归档、理解、检索和资料管理。")}</p><div className="settings-link-grid discovery-settings-grid">{cards.map(card => { const Icon=settingsIcons[card.id]??Settings2; return <button key={card.id} disabled={!webFeatures.page(card.id)} onClick={() => onPage(card.id)}><Icon size={18}/><span><strong>{card.title}</strong><small>{card.description}</small>{!webFeatures.page(card.id)&&<small>{moteText("当前服务未提供此入口")}</small>}</span><ChevronRight size={16}/></button>;})}{extra.map(entry => <button key={entry.id} onClick={() => onPage(entry.id)}><Settings2 size={18}/><span><strong>{entry.label}</strong><small>{moteText("打开此功能查看状态与操作。")}</small></span><ChevronRight size={16}/></button>)}</div><details className="panel discovery-settings-boundary"><summary>{moteText("记忆设置分两处，各管什么？")}</summary><p><strong>{moteText("模型与服务 → 模块与模型")}</strong>{moteText("：选择模型、自动配方和历史资料的处理节奏。")}</p><p><strong>{moteText("自动记忆与插件 → 记忆方案")}</strong>{moteText("：暂停 / 恢复自动记忆，查看或准备更换当前方案。更换方案需先准备，再确认生效。")}</p></details></section>;
}
