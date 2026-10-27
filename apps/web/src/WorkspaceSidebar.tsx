import { ChartNoAxesColumn, Database, House, Link2, Bot, MessageSquare, Settings2, Grid2X2 } from 'lucide-react';
import { moteText } from '@mote/shared/i18n';
import { moteBrand, uiDestinationPresentation, type UiDestinationIcon, type UiLayoutProfile } from '@mote/shared';
import type { Connection } from './api';
import { primaryDestination } from './WorkspaceNavigation';

export const destinationIcons: Record<UiDestinationIcon, typeof House> = { home: House, library: Database, sources: Link2, agent: Bot, ask: MessageSquare, activity: ChartNoAxesColumn };
export const destinationPages = { home: 'overview', library: 'archive', sources: 'sources', connections: 'connections', ask: 'ask', activity: 'activity' } as const;

export function WorkspaceSidebar({ layout, page, onPage, connection, verified, profile, onConnect }: {
  layout: UiLayoutProfile;
  page: string;
  onPage: (page: string) => void;
  connection: Connection | null;
  verified: boolean;
  profile?: string;
  onConnect: () => void;
}) {
  return <aside id="primary-navigation" className="sidebar">
    <button className="brand" onClick={() => onPage('overview')} aria-label={moteText(uiDestinationPresentation.home.label)}><span className="mote-symbol" aria-hidden="true">m</span><span>{moteBrand.name}</span></button>
    <div className="workspace-label">{moteText(moteBrand.tagline)}</div>
    <nav aria-label={moteText('主导航')}>
      {layout.primary.map(id => {
        const item=uiDestinationPresentation[id], target=destinationPages[id], Icon = destinationIcons[item.icon], active = primaryDestination(page) === target;
        return <button key={target} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={() => onPage(target)}><Icon size={18} strokeWidth={1.7}/><span>{moteText(item.label)}</span></button>;
      })}
    </nav>
    <div className="sidebar-bottom">
      <button className="auxiliary-nav" aria-current={page === 'featureGuide' ? 'page' : undefined} onClick={() => onPage('featureGuide')}><Grid2X2 size={16}/>{moteText('全部功能')}</button>
      <button className="settings-nav" aria-current={primaryDestination(page) === 'about' ? 'page' : undefined} onClick={() => onPage('about')}><Settings2 size={16}/>{moteText('设置')}</button>
      <button className="node-button" onClick={() => connection ? onPage('about') : onConnect()}><span className={`node-state ${verified ? 'online' : ''}`}/><span><strong>{verified ? moteText('已登录 · {0}', profile || moteText('当前节点')) : connection ? moteText('正在验证登录') : moteText('登录 Mote')}</strong><small>{verified ? moteText('管理当前节点') : moteText('使用管理令牌访问资料')}</small></span></button>
    </div>
  </aside>;
}
