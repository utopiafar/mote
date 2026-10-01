import { moteText } from '@mote/shared/i18n';
import { ArrowLeft, ArrowRight, Settings2 } from 'lucide-react';
import { webFeatures } from './features/registry';
import { LanguageSelector } from './LanguageSelector';
import { pageLabels, sectionFor, sections, type Page } from './navigation';

const integrated = new Set(['archive','timeline','materials','files','memories']);
export function primaryDestination(page: Page) {
  const section=sectionFor(page);
  if (section === 'library') return 'archive';
  if (section === 'connections') return 'devices';
  if (page === 'actions') return 'overview';
  return ['overview','archive','ask','devices'].includes(page)?page:'about';
}
export function WorkspaceNavigation({page,onPage}:{page:Page;onPage:(page:Page)=>void}) {
  const section=sectionFor(page);
  if (section==='library') {
    const tools=sections.library.filter(id=>!integrated.has(id));
    return <div className="workspace-context">
      {page!=='archive'&&<button className="back-link" onClick={()=>onPage('archive')}><ArrowLeft size={16}/>{moteText('返回资料库')}</button>}
      <label className="workspace-tool-select"><span>{moteText('资料库工具')}</span><select aria-label={moteText('资料库工具')} value={tools.includes(page)?page:''} onChange={event=>{if(event.target.value)onPage(event.target.value);}}><option value="">{moteText('选择工具')}</option>{tools.map(id=><option value={id} key={id}>{pageLabels[id]}</option>)}</select></label>
    </div>;
  }
  if(section==='connections') {
    const tools=sections.connections.filter(id=>id!=='devices');
    return <div className="workspace-context">
      {page!=='devices'&&<button className="back-link" onClick={()=>onPage('devices')}><ArrowLeft size={16}/>{moteText('返回采集与设备')}</button>}
      <label className="workspace-tool-select"><span>{moteText('来源与连接')}</span><select aria-label={moteText('来源与连接')} value={tools.includes(page)?page:''} onChange={event=>{if(event.target.value)onPage(event.target.value);}}><option value="">{moteText('管理来源或授权')}</option>{tools.map(id=><option value={id} key={id}>{pageLabels[id]}</option>)}</select></label>
    </div>;
  }
  if(primaryDestination(page)==='about'&&page!=='about') return <button className="back-link workspace-back" onClick={()=>onPage('about')}><ArrowLeft size={16}/>{moteText('返回设置')}</button>;
  if(page==='actions')return <button className="back-link workspace-back" onClick={()=>onPage('overview')}><ArrowLeft size={16}/>{moteText('返回今天')}</button>;
  return null;
}
export function SettingsLanding({onPage}:{onPage:(page:Page)=>void}) {
  const system=sections.system;
  const extra=webFeatures.pages().filter(entry=>!entry.section&&!new Set(['overview','ask','actions','about','help']).has(entry.id)).map(entry=>entry.id);
  return <section className="settings-destinations"><LanguageSelector/><div><h2>{moteText('服务与资料')}</h2><p>{moteText('模型、存储与处理方式都在这里调整。')}</p></div><div className="settings-link-grid">{[...system,...extra,'help'].filter(id=>pageLabels[id]).map(id=><button key={id} onClick={()=>onPage(id)}><Settings2 size={18}/><span>{pageLabels[id]}</span><ArrowRight size={16}/></button>)}</div></section>;
}
