import { moteText } from '@mote/shared/i18n';
import { ArrowLeft, ArrowRight, Settings2 } from 'lucide-react';
import { webFeatures } from './features/registry';
import { LanguageSelector } from './LanguageSelector';
import { pageLabels, sectionFor, sections, type Page } from './navigation';

export function primaryDestination(page: Page) {
  const section=sectionFor(page);
  if (section === 'library') return 'archive';
  if (section === 'connections') return 'devices';
  if (page === 'processing') return 'activity';
  if (page === 'actions') return 'overview';
  return ['overview','archive','ask','activity','devices'].includes(page)?page:'about';
}
export function WorkspaceNavigation({page,onPage}:{page:Page;onPage:(page:Page)=>void}) {
  const section=sectionFor(page);
  if (section==='library') {
    const tools=sections.library.filter(id=>id!=='archive');
    return <div className="workspace-context">
      {page!=='archive'&&<button className="back-link" aria-label={moteText('返回{0}',pageLabels.archive)} onClick={()=>onPage('archive')}><ArrowLeft size={16}/>{moteText('返回上级')}</button>}
      <label className="workspace-tool-select"><span>{moteText('资料库工具')}</span><select aria-label={moteText('资料库工具')} value={tools.includes(page)?page:''} onChange={event=>{if(event.target.value)onPage(event.target.value);}}><option value="">{moteText('选择工具')}</option>{tools.map(id=><option value={id} key={id}>{pageLabels[id]}</option>)}</select></label>
    </div>;
  }
  if(section==='connections') {
    const tools=sections.connections.filter(id=>id!=='devices');
    return <div className="workspace-context">
      {page!=='devices'&&<button className="back-link" aria-label={moteText('返回{0}',pageLabels.devices)} onClick={()=>onPage('devices')}><ArrowLeft size={16}/>{moteText('返回上级')}</button>}
      <label className="workspace-tool-select"><span>{moteText('来源与连接')}</span><select aria-label={moteText('来源与连接')} value={tools.includes(page)?page:''} onChange={event=>{if(event.target.value)onPage(event.target.value);}}><option value="">{moteText('管理来源或授权')}</option>{tools.map(id=><option value={id} key={id}>{pageLabels[id]}</option>)}</select></label>
    </div>;
  }
  // The models page owns its nested categories and their single parent control.
  if(page==='settings')return null;
  if(page==='processing')return <button className="back-link workspace-back" aria-label={moteText('返回活动')} onClick={()=>onPage('activity')}><ArrowLeft size={16}/>{moteText('返回上级')}</button>;
  if(primaryDestination(page)==='about'&&page!=='about') return <button className="back-link workspace-back" aria-label={moteText('返回{0}',pageLabels.about)} onClick={()=>onPage('about')}><ArrowLeft size={16}/>{moteText('返回上级')}</button>;
  if(page==='actions')return <button className="back-link workspace-back" aria-label={moteText('返回{0}',pageLabels.overview)} onClick={()=>onPage('overview')}><ArrowLeft size={16}/>{moteText('返回上级')}</button>;
  return null;
}
export function SettingsLanding({onPage}:{onPage:(page:Page)=>void}) {
  const system=sections.system;
  const extra=webFeatures.pages().filter(entry=>!entry.section&&!new Set(['overview','ask','actions','activity','processing','about','help']).has(entry.id)).map(entry=>entry.id);
  return <section className="settings-destinations"><LanguageSelector/><div><h2>{moteText('服务与资料')}</h2><p>{moteText('模型、存储与处理方式都在这里调整。')}</p></div><div className="settings-link-grid">{[...system,...extra,'help'].filter(id=>pageLabels[id]).map(id=><button key={id} onClick={()=>onPage(id)}><Settings2 size={18}/><span>{pageLabels[id]}</span><ArrowRight size={16}/></button>)}</div></section>;
}
