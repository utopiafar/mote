/** Current routes use explicit collection query parameters. */
export function canonicalDestination(page: string, collection: string, available: readonly string[]) {
  return {
    page,
    collection: available.includes(collection) ? collection : available[0] ?? 'materials',
  };
}
export function readWorkspaceRoute(hash: string, readPage: (hash: string) => string, available: readonly string[]) {
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  return canonicalDestination(readPage(hash), query.get('view') ?? 'materials', available);
}
export function workspaceHash(route: string, collection?: string, existingHash?: string) {
  const query = new URLSearchParams(existingHash?.split('?')[1] ?? '');
  if (collection) query.set('view', collection); else query.delete('view');
  const suffix = query.toString();
  return '#/' + route + (suffix ? '?' + suffix : '');
}
