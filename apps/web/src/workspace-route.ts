/** Current routes use explicit collection query parameters. */
export function canonicalDestination(page: string, collection: string, available: readonly string[]) {
  if (page === 'archive' && collection === 'work-activity') return { page: 'activity', collection: 'materials' };
  return { page, collection };
}
export function readWorkspaceRoute(hash: string, readPage: (hash: string) => string, available: readonly string[]) {
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  const raw=hash.replace(/^#\/?/,'').split('?')[0];
  if (!raw) return canonicalDestination('overview', query.get('view') ?? 'materials', available);
  return canonicalDestination(readPage(hash), query.get('view') ?? 'materials', available);
}
export function workspaceHash(route: string, collection?: string, existingHash?: string) {
  const query = new URLSearchParams(existingHash?.split('?')[1] ?? '');
  if (collection) query.set('view', collection); else query.delete('view');
  const suffix = query.toString();
  return '#/' + route + (suffix ? '?' + suffix : '');
}
