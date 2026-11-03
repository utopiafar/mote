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
    if(section==='connections'&&page!=='sources'&&page!=='connections')return 'sources';
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
        if(page==='archive')return null; // The library owns its view links and secondary tools.
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
        return null; // The directory owns its source-context return in its heading.
    const parent=parentDestination(page);
    return parent?<button className="back-link workspace-back" aria-label={moteText('返回{0}',pageLabels[parent])} onClick={()=>onPage(parent)}><ArrowLeft size={16}/>{moteText('返回上级')}</button>:null;
}
export function SettingsLanding({ onPage }: {
    onPage: (page: Page) => void;
}) {
    useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
    const groups=[{title:moteText('理解与扩展'),items:[['settings',moteText('模型与服务'),moteText('模型连接、图片和录音处理')],['extensions',moteText('自动记忆与插件'),moteText('自动记忆、方案与处理节奏')],['usage',moteText('用量与费用'),moteText('使用记录与已知费用')]]},{title:moteText('数据与维护'),items:[['vault',moteText('存储与备份'),moteText('导入导出、保存方式与存储空间')],['developer',moteText('运行与诊断'),moteText('运行状态、问题诊断与高级配置')]]},{title:moteText('使用与帮助'),items:[['localPreferences',moteText('外观、语言与会话'),''],['featureGuide',moteText('全部功能'),moteText('按要做的事情找入口')],['help',moteText('版本与反馈'),'']]}];
    const known=new Set([...groups.flatMap(group=>group.items.map(item=>item[0])), 'about','overview','ask','actions','activity','processing','search','coding','statistics','agentView']);
    const extra=webFeatures.pages().filter(entry=>(entry.section==='system'||!entry.section)&&!known.has(entry.id));
    const row=([id,title,description,href]:string[])=>{const Icon=settingsIcons[id]??Settings2,available=id==='extensions'||Boolean(webFeatures.page(id));return <button key={id+":"+title} disabled={!available} onClick={()=>href?window.location.hash=href:onPage(id)}><Icon size={18}/><span><strong>{title}</strong>{description&&<small>{description}</small>}{!available&&<small>{moteText("当前服务未提供此入口")}</small>}</span><ChevronRight size={16}/></button>;};
    return <section className="settings-destinations final-settings-directory">{groups.slice(0,2).map(group=><section className="settings-directory-group" key={group.title}><h2>{group.title}</h2><div className="settings-directory-rows">{group.items.map(row)}</div></section>)}<details className="settings-directory-advanced"><summary>{moteText('其他设置')}</summary><div className="settings-directory-rows">{row(['actions',moteText('日程建议与执行'),moteText('发现、设备与日程执行范围')])}{row(['settings',moteText('定期生成发现'),moteText('生成周期与新增资料门槛'),'#/system/models?category=model&section=automatic'])}{row(['settings',moteText('活动整理'),moteText('是否整理后续采集内容'),'#/system/models?category=model&section=automatic'])}{row(['agentView',moteText('Agent 能看到什么'),''])}{row(['help',moteText('帮助与反馈'),moteText('连接、处理与维护')])}{extra.map(entry=>row([entry.id,entry.label??entry.id,'']))}</div><AppearanceSelector/></details><div className="settings-directory-related"><button className="text-button" onClick={()=>onPage('sources')}>{moteText('管理来源')} →</button><button className="text-button" onClick={()=>onPage('connections')}>{moteText('AI 接入')} →</button></div>{groups.slice(2).map(group=><section className="settings-directory-group" key={group.title}><h2>{group.title}</h2><div className="settings-directory-rows">{group.items.map(row)}</div></section>)}</section>;
}
