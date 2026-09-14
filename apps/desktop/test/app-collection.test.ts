import { describe, expect, it } from 'vitest';
import { collectionForApp, normalizeAppCollectionRules, permitsVisibleContent } from '../src/app-collection';
import { defaultConfig, updateConfig } from '../src/config';
describe('explicit collection policy', () => {
  it('preserves default content and exact legacy exclusions while allowing per-app activity/off', () => {
    const cfg = { ...defaultConfig(), excludedAppIds: ['dev.legacy'], appCollectionRules: { 'dev.activity': 'activity', 'dev.off': 'off', 'dev.legacy': 'content' } } as const;
    expect(collectionForApp('dev.normal', cfg)).toBe('content'); expect(collectionForApp('dev.activity', cfg)).toBe('activity'); expect(collectionForApp('dev.off', cfg)).toBe('off'); expect(collectionForApp('dev.legacy', cfg)).toBe('off'); expect(collectionForApp(undefined, cfg)).toBe('off'); expect(collectionForApp('dev.activity.other', cfg)).toBe('content');
    expect(permitsVisibleContent(['dev.normal', 'dev.activity'], false, cfg)).toBe(false); expect(permitsVisibleContent(['dev.normal'], true, cfg)).toBe(false);
  });
  it('migrates config without new fields and rejects malformed policies instead of weakening filters', () => {
    const cfg = defaultConfig(); const { defaultCollection, appCollectionRules, metadataEnabled, ...legacy } = cfg;
    const migrated = updateConfig(cfg, legacy as never); expect(migrated.defaultCollection).toBe('content'); expect(migrated.appCollectionRules).toEqual({}); expect(migrated.metadataEnabled).toBe(true);
    for (const rules of [[], { 'dev.app': 'keyword-guess' }, { '': 'off' }, JSON.parse('{"__proto__":"content"}')]) expect(() => normalizeAppCollectionRules(rules)).toThrow();
    expect(() => updateConfig(cfg, { ...cfg, defaultCollection: 'invalid' } as never)).toThrow();
  });
});
