import {
  Brain, LayoutGrid, Lightbulb, MessageCircle, Newspaper, Plug, Puzzle, SlidersHorizontal, SquareCheck,
  type LucideIcon,
} from 'lucide-react';
import {useContext,type ReactNode} from 'react';
import {moteText} from '@mote/shared/i18n';
import {moteBrand} from '@mote/shared';
import {MoteMark} from './Loading';
import {primaryDestination} from './WorkspaceNavigation';
import {type Page, type WorkspaceNavItem, workspaceNavigation} from './navigation';
import {NavStateContext} from './use-nav-state';

const icons:Record<string,LucideIcon>={
  'message-circle':MessageCircle,
  newspaper:Newspaper,
  lightbulb:Lightbulb,
  'square-check':SquareCheck,
  'layout-grid':LayoutGrid,
  brain:Brain,
  puzzle:Puzzle,
  plug:Plug,
  'sliders-horizontal':SlidersHorizontal,
};

type NavigationProps={
  page:Page;
  onPage:(page:Page)=>void;
  groups:ReturnType<typeof workspaceNavigation>;
};

function NavLinks({items,page,onPage}:{items:WorkspaceNavItem[]} & Omit<NavigationProps,'groups'>){
  const badges=useContext(NavStateContext)?.badges;
  const active=primaryDestination(page);
  return items.map(item=>{
    const Icon=icons[item.icon];
    const label=moteText(item.label);
    const ideas=badges?.ideas??0;
    const count=item.badge==='ideas'&&ideas>0?ideas:undefined;
    const needsAuthorization=item.badge==='connections'&&badges?.connections===true;
    const name=count!==undefined?`${label} (${count})`:needsAuthorization?`${label} · ${moteText('需要重新授权')}`:label;
    return <button key={item.id} type="button" data-nav-item={item.id} title={name} aria-label={name}
      aria-current={active===item.page?'page':undefined} onClick={()=>onPage(item.page)}>
      <span className="workspace-nav-icon">
        <Icon size={20} strokeWidth={1.5} aria-hidden="true"/>
        {count!==undefined&&<span className="workspace-nav-badge" data-nav-badge="ideas" aria-hidden="true">{count}</span>}
        {needsAuthorization&&<span className="workspace-nav-badge" data-nav-badge="connections" aria-hidden="true"/>}
      </span>
      <span className="workspace-nav-label">{label}</span>
    </button>;
  });
}

export function WorkspaceSidebar({groups,page,onPage}:NavigationProps){
  return <>
    <style>{sidebarStyles}</style>
    <aside id="primary-navigation" className="sidebar workspace-sidebar">
      <div className="brand" role="img" aria-label={moteBrand.name}><MoteMark/></div>
      <nav aria-label={moteText('主导航')}>
        <div data-nav-group="daily"><NavLinks items={groups.daily} page={page} onPage={onPage}/></div>
        <div data-nav-group="manage"><NavLinks items={groups.manage} page={page} onPage={onPage}/></div>
      </nav>
    </aside>
  </>;
}

export function WorkspaceMenu({groups,page,pageLabel,onPage,children}:NavigationProps & {
  pageLabel:string;
  children?:ReactNode;
}){
  return <details className="shell-menu shell-mobile-menu">
    <summary aria-label={moteText('主导航')}>{pageLabel}</summary>
    <div onClick={event=>{
      if(event.target instanceof Element&&event.target.closest('button')){
        (event.currentTarget.parentElement as HTMLDetailsElement).open=false;
      }
    }}>
      <NavLinks items={[...groups.daily,...groups.manage]} page={page} onPage={onPage}/>
      {children}
    </div>
  </details>;
}

const sidebarStyles=`
.workspace-nav-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.workspace-nav-badge {
  position: absolute;
  top: -3px;
  left: calc(100% - 5px);
  border-radius: 999px;
  pointer-events: none;
}
.workspace-nav-badge[data-nav-badge=ideas] {
  min-width: 15px;
  padding-inline: 3px;
  background: var(--mote-accent);
  color: var(--mote-background);
  font: 600 10px/15px var(--mote-font);
  text-align: center;
}
.workspace-nav-badge[data-nav-badge=connections] {
  width: 7px;
  height: 7px;
  background: var(--mote-warning);
}
.app-shell[data-navigation] .workspace-sidebar .brand {
  justify-content: center;
  margin: 0;
  padding: 0;
}
.app-shell[data-navigation] .workspace-sidebar .brand .mote-mark {
  width: 30px;
  height: 30px;
}
.workspace-sidebar [data-nav-group] {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.shell-mobile-menu button[data-nav-item] {
  display: flex;
  align-items: center;
  gap: var(--mote-space-inline);
}
.shell-mobile-menu button[data-nav-item][aria-current=page] {
  color: var(--mote-accent);
  background: var(--mote-tint);
}
@media (min-width: 761px) {
  html:has(.app-shell[data-navigation]:not([data-navigation=top]) > .workspace-sidebar) {
    --workspace-rail-width: 72px;
  }
  .app-shell[data-navigation]:not([data-navigation=top]) > .workspace-sidebar {
    width: var(--workspace-rail-width);
    padding: 16px 6px;
    gap: 16px;
  }
  .app-shell[data-navigation]:not([data-navigation=top]):has(> .workspace-sidebar) > .main {
    width: calc(100% - var(--workspace-rail-width));
    margin-left: var(--workspace-rail-width);
  }
  html:has(.app-shell[data-navigation]:not([data-navigation=top]) > .workspace-sidebar) .evidence-reader-backdrop {
    left: var(--workspace-rail-width);
  }
  .app-shell[data-navigation] .workspace-sidebar > nav {
    flex: 1;
    gap: 16px;
    width: 100%;
    overflow: visible;
  }
  .workspace-sidebar [data-nav-group=manage] {
    margin-top: auto;
  }
  .app-shell[data-navigation] .workspace-sidebar nav button[data-nav-item] {
    flex-direction: column;
    justify-content: center;
    min-height: 54px;
    gap: 4px;
    padding: 6px 1px;
    color: var(--mote-sidebar-muted);
    font-size: var(--mote-font-meta);
    line-height: 1.2;
    text-align: center;
  }
  .app-shell[data-navigation] .workspace-sidebar button[data-nav-item][aria-current=page] {
    background: var(--mote-sidebar-tint);
    color: var(--mote-sidebar-ink);
  }
  .workspace-sidebar .workspace-nav-label {
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .workspace-sidebar .workspace-nav-label:is(:lang(zh),:lang(ja)) {
    max-width: min(100%, 3.5em);
  }
  .app-shell[data-navigation=top] .workspace-sidebar [data-nav-group] {
    flex-direction: row;
    margin: 0;
  }
}
`;
