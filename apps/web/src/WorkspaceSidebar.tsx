import { ChartNoAxesColumn, Database, House, Link2, Bot, MessageSquare } from 'lucide-react';
import { moteText } from '@mote/shared/i18n';
import { moteBrand, uiDestinationPresentation, type UiDestinationIcon, type UiLayoutProfile } from '@mote/shared';
import type { Connection } from './api';
import { primaryDestination } from './WorkspaceNavigation';

export const destinationIcons: Record<UiDestinationIcon, typeof House> = { home: House, library: Database, sources: Link2, agent: Bot, ask: MessageSquare, activity: ChartNoAxesColumn };
export const destinationPages = { home: 'overview', library: 'archive', sources: 'sources', connections: 'connections', ask: 'ask', activity: 'activity' } as const;
const destinationGlyphs = { home:'⌂', library:'▤', sources:'↗', agent:'◇', ask:'◌', activity:'◷' } as const;

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
  return <aside id="primary-navigation" className="sidebar">
    <button className="brand" onClick={() => onPage('overview')} aria-label={moteText(uiDestinationPresentation.home.label)}><span className="mote-symbol" aria-hidden="true">m</span><span>{moteBrand.name}</span></button>
    <nav aria-label={moteText('主导航')}>
      {layout.primary.map(id => {
        const item=uiDestinationPresentation[id], target=destinationPages[id], active = page!=='featureGuide'&&primaryDestination(page) === target;
        return <button key={target} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={() => onPage(target)}><span className="nav-glyph" aria-hidden="true">{destinationGlyphs[item.icon]}</span><span>{moteText(item.label)}</span></button>;
      })}
    </nav>
    <div className="sidebar-bottom">
      <button className="settings-nav" aria-current={primaryDestination(page) === 'about' ? 'page' : undefined} onClick={() => onPage('about')}><span className="nav-glyph" aria-hidden="true">⚙</span>{moteText('设置')}</button>
      <details className="workspace-node-menu"><summary className="node-button"><span className={`node-state ${verified ? 'online' : ''}`}/><span>{verified?moteText('我的 Mote'):connection?moteText('正在验证登录'):moteText('登录 Mote')}</span></summary><div>
        {verified&&<p>{moteText('已登录 · {0}',profile||moteText('当前节点'))}</p>}
        <button onClick={event=>{event.currentTarget.closest('details')!.open=false;onPage('featureGuide');}}>{moteText('全部功能')}</button>
        <button onClick={event=>{event.currentTarget.closest('details')!.open=false;connection?onPage('about'):onConnect();}}>{connection?moteText('登录会话'):moteText('登录 Mote')}</button>
        {connection&&onRefresh&&<button aria-label={moteText('刷新资料')} disabled={refreshing} onClick={onRefresh}>{moteText('刷新资料')}</button>}
      </div></details>
    </div>
  </aside>;
}
