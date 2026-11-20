/** Central page destinations opened from every end. The values are the
 * current workspace routes; NV3 changes them here, never in a client. Keys use
 * the revised page names (chat is the former ask page). Deep-link route kinds
 * stay in deep-link.ts. */
export const pageRoutes = {
  chat: 'chat',
  library: 'library',
  models: 'system/models',
  skills: 'system/plugins',
  connections: 'connections',
  lark: 'connections/lark',
  actions: 'actions',
  activity: 'activity',
} as const;

export type PageRouteKey = keyof typeof pageRoutes;

/** Canonical page hash: '#/' + the shared route + an optional query string.
 * Query values are address data only; credentials never belong here. */
export function pageHash(key: PageRouteKey, query?: Record<string, string>): string {
  if (!Object.hasOwn(pageRoutes, key)) throw new TypeError('Invalid page route');
  const suffix = new URLSearchParams(query).toString();
  return '#/' + pageRoutes[key] + (suffix ? '?' + suffix : '');
}
