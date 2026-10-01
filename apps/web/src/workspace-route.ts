/** Authored navigation aliases. Captured content never participates in routing. */
const legacyCollections: Readonly<Record<string, string>> = {
  timeline: 'segments', materials: 'materials', files: 'files', memories: 'memories',
};
export function canonicalDestination(page: string, collection: string, available: readonly string[]) {
  const requested = legacyCollections[page];
  return {
    page: requested ? 'archive' : page,
    collection: available.includes(requested ?? collection) ? requested ?? collection : available[0] ?? 'records',
  };
}
export function readWorkspaceRoute(hash: string, readPage: (hash: string) => string, available: readonly string[]) {
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  return canonicalDestination(readPage(hash), query.get('view') ?? 'records', available);
}
export function workspaceHash(route: string, collection?: string, existingHash?: string) {
  const query = new URLSearchParams(existingHash?.split('?')[1] ?? '');
  if (collection) query.set('view', collection); else query.delete('view');
  const suffix = query.toString();
  return '#/' + route + (suffix ? '?' + suffix : '');
}
