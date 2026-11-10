import { Activity, Database, House, Link2, Bot, MessageSquare, Settings } from 'lucide-react';
import { moteText } from '@mote/shared/i18n';
import { moteBrand, uiDestinationPresentation, type UiDestination, type UiDestinationIcon, type UiLayoutProfile } from '@mote/shared';
import type { Connection } from './api';
import { primaryDestination } from './WorkspaceNavigation';
import { MoteMark } from './Loading';
import { destinationPages } from './navigation';

export const destinationIcons: Record<UiDestinationIcon, typeof House> = { home: House, library: Database, sources: Link2, agent: Bot, ask: MessageSquare, activity: Activity };

export function WorkspaceSidebar({ layout, page, onPage, connection, verified, profile, onConnect, onRefresh, refreshing=false }: {
  layout: UiLayoutProfile;
  page: string;
  onPage: (page: string) => void;
  connection: Connection | null;
  verified: boolean;
  profile?: string;
  onConnect: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const destination = (id: UiDestination, className: string) => {
    const item=uiDestinationPresentation[id], Icon=destinationIcons[item.icon], active=page!=='featureGuide'&&primaryDestination(page)===destinationPages[id];
    return <button key={id} className={[className,active?'active':''].filter(Boolean).join(' ')} aria-current={active?'page':undefined} onClick={() => onPage(destinationPages[id])}><Icon size={16} strokeWidth={1.5} aria-hidden="true"/><span>{moteText(item.label)}</span></button>;
  };
  return <aside id="primary-navigation" className="sidebar">
    <button className="brand" onClick={() => onPage('overview')} aria-label={moteText(uiDestinationPresentation.home.label)}><MoteMark/><span>{moteBrand.name}</span></button>
    <nav aria-label={moteText('主导航')}>
      {layout.primary.map(id => destination(id, ''))}
    </nav>
    <div className="sidebar-bottom">
      {layout.secondary?.map(id => destination(id, 'utility-nav'))}
      <button className={'settings-nav'+(primaryDestination(page) === 'about' ? ' active' : '')} aria-current={primaryDestination(page) === 'about' ? 'page' : undefined} onClick={() => onPage('about')}><Settings size={16} strokeWidth={1.5} aria-hidden="true"/>{moteText('设置')}</button>
      <details className="workspace-node-menu"><summary className="node-button"><span className={`node-state ${verified ? 'online' : ''}`}/><span>{verified?moteText('我的 Mote'):connection?moteText('正在验证登录'):moteText('登录 Mote')}</span></summary><div>
        {verified&&<p>{moteText('已登录 · {0}',profile||moteText('当前节点'))}</p>}
        <button onClick={event=>{event.currentTarget.closest('details')!.open=false;onPage('featureGuide');}}>{moteText('全部功能')}</button>
        <button onClick={event=>{event.currentTarget.closest('details')!.open=false;connection?onPage('about'):onConnect();}}>{connection?moteText('登录会话'):moteText('登录 Mote')}</button>
        {connection&&onRefresh&&<button aria-label={moteText('刷新资料')} disabled={refreshing} onClick={onRefresh}>{moteText('刷新资料')}</button>}
      </div></details>
    </div>
  </aside>;
}
