import type { CollectionMode, Config } from './contracts';
export type CollectionPolicy = Pick<Config, 'defaultCollection' | 'appCollectionRules' | 'excludedAppIds'>;
export function normalizeCollectionMode(value: unknown): CollectionMode {
  if (value !== 'content' && value !== 'activity' && value !== 'off') throw new Error('采集级别必须是完整内容、仅应用活动或不记录');
  return value;
}
export function normalizeAppCollectionRules(value: unknown): Record<string, CollectionMode> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) throw new Error('应用采集规则必须为有效列表，最多 500 项');
  const result: Record<string, CollectionMode> = {};
  for (const [id, mode] of Object.entries(value)) {
    if (!id.trim() || id !== id.trim() || id.length > 256 || /[\x00-\x20\x7f]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('应用 Bundle ID 无效');
    Object.defineProperty(result, id, { value: normalizeCollectionMode(mode), enumerable: true, configurable: true, writable: true });
  }
  return result;
}
export const UNKNOWN_FOREGROUND = 'dev.mote.unknown-foreground';
export function hasRestrictedApplications(policy: CollectionPolicy): boolean {
  return policy.defaultCollection !== 'content' || policy.excludedAppIds.length > 0 || Object.values(policy.appCollectionRules).some(mode => mode !== 'content');
}
/** Missing foreground/window identity only blocks content when it could bypass an explicit restriction. */
export function collectionForApp(appId: string | undefined, policy: CollectionPolicy): CollectionMode {
  if (!appId || appId === UNKNOWN_FOREGROUND) {
    if (appId && (policy.excludedAppIds.includes(appId) || Object.hasOwn(policy.appCollectionRules, appId))) return policy.excludedAppIds.includes(appId) ? 'off' : policy.appCollectionRules[appId];
    return hasRestrictedApplications(policy) ? 'off' : policy.defaultCollection;
  }
  if (policy.excludedAppIds.includes(appId)) return 'off';
  return Object.hasOwn(policy.appCollectionRules, appId) ? policy.appCollectionRules[appId] : policy.defaultCollection;
}
/** A full-screen frame must not contain any application configured to withhold content. */
export function permitsVisibleContent(ids: string[], unknown: boolean, policy: CollectionPolicy): boolean {
  return (!unknown || !hasRestrictedApplications(policy)) && ids.every(id => collectionForApp(id, policy) === 'content');
}
