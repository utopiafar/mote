/** Navigation is product structure, never semantic classification of captured content. */
export const sections = {
  library: ['archive', 'timeline', 'files', 'notes', 'memories', 'insights', 'imports'],
  connections: ['sources', 'devices', 'connections', 'lark'],
  system: ['statistics', 'processing', 'extensions', 'settings', 'usage', 'vault', 'developer'],
} as const;
export type Page = 'overview' | 'ask' | 'actions' | 'about' | 'help' | typeof sections[keyof typeof sections][number];
export const routes: Record<Page, string> = {
  overview: 'today', archive: 'library', timeline: 'library/segments', files: 'library/files',
  notes: 'library/notes', memories: 'library/memories', insights: 'library/insights', imports: 'library/import',
  ask: 'ask', actions: 'actions', sources: 'connections', devices: 'connections/devices',
  connections: 'connections/access', lark: 'connections/lark', statistics: 'system',
  processing: 'system/processing', extensions: 'system/extensions', settings: 'system/models',
  usage: 'system/usage', vault: 'system/storage', developer: 'system/diagnostics', about: 'preferences', help: 'help',
};
export function readPage(hash: string): Page {
  const route = hash.replace(/^#\/?/, '').split('?')[0];
  return (Object.keys(routes) as Page[]).find(page => routes[page] === route)
    ?? (Object.hasOwn(routes, route) ? route as Page : 'overview');
}
export function sectionFor(page: Page) {
  return Object.entries(sections).find(([, pages]) => (pages as readonly string[]).includes(page))?.[0] ?? page;
}
