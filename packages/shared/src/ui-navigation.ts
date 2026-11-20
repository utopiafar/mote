export type NavItemId = 'chat'|'feed'|'ideas'|'goals'|'library'|'memory'|'skills'|'connections'|'settings';
export type NavGroup = 'daily'|'manage';
export type NavItem = {
  id: NavItemId;
  label: string;
  group: NavGroup;
  order: number;
  icon: string;
  packageId: string;
  badge?: 'ideas'|'connections';
};

export const officialNavigation: readonly NavItem[] = [
  {id: 'chat', label: '聊天', group: 'daily', order: 10, icon: 'message-circle', packageId: 'mote.ask'},
  {id: 'feed', label: '动态', group: 'daily', order: 20, icon: 'newspaper', packageId: 'mote.assistant'},
  {id: 'ideas', label: '点子', group: 'daily', order: 30, icon: 'lightbulb', packageId: 'mote.assistant', badge: 'ideas'},
  {id: 'goals', label: '目标', group: 'daily', order: 40, icon: 'square-check', packageId: 'mote.assistant'},
  {id: 'library', label: '资料库', group: 'daily', order: 50, icon: 'layout-grid', packageId: 'mote.library'},
  {id: 'memory', label: '记忆', group: 'manage', order: 10, icon: 'brain', packageId: 'mote.assistant'},
  {id: 'skills', label: '技能', group: 'manage', order: 20, icon: 'puzzle', packageId: 'mote.features'},
  {id: 'connections', label: '连接', group: 'manage', order: 30, icon: 'plug', packageId: 'mote.connections', badge: 'connections'},
  {id: 'settings', label: '设置', group: 'manage', order: 40, icon: 'sliders-horizontal', packageId: 'mote.system'},
];

export type PinnedNavPage = {pageId: string; label: string; packageId: string};

export function navigationFor({enabledPackages, registered, pinned = []}: {
  enabledPackages: ReadonlySet<string>;
  registered: ReadonlySet<NavItemId>;
  pinned?: readonly PinnedNavPage[];
}): {daily: Array<NavItem|PinnedNavPage>; manage: NavItem[]} {
  const groups: Record<NavGroup, NavItem[]> = {daily: [], manage: []};
  for (const item of officialNavigation) {
    if (enabledPackages.has(item.packageId) && registered.has(item.id)) groups[item.group].push(item);
  }
  const compare = (a: NavItem, b: NavItem) => a.order - b.order || a.id.localeCompare(b.id, 'en');

  const seen = new Set<string>();
  const pinnedDaily = pinned.filter(page => {
    if (!enabledPackages.has(page.packageId) || seen.has(page.pageId)) return false;
    seen.add(page.pageId);
    return true;
  });
  return {daily: [...groups.daily.sort(compare), ...pinnedDaily], manage: groups.manage.sort(compare)};
}
