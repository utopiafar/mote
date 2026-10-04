import { describe, expect, it } from 'vitest';
import { collectionForApp, normalizeAppCollectionRules, permitsVisibleContent } from '../src/app-collection';
import { defaultConfig, updateConfig } from '../src/config';
describe('explicit collection policy', () => {
  it('preserves default content and exact off rules while allowing per-app activity/off', () => {
    const cfg = { ...defaultConfig(), appCollectionRules: { 'dev.activity': 'activity', 'dev.off': 'off', 'dev.legacy': 'off' } } as const;
    expect(collectionForApp('dev.normal', cfg)).toBe('content'); expect(collectionForApp('dev.activity', cfg)).toBe('activity'); expect(collectionForApp('dev.off', cfg)).toBe('off'); expect(collectionForApp('dev.legacy', cfg)).toBe('off'); expect(collectionForApp(undefined, cfg)).toBe('off'); expect(collectionForApp('dev.activity.other', cfg)).toBe('content');
    expect(permitsVisibleContent(['dev.normal', 'dev.activity'], false, cfg)).toBe(false); expect(permitsVisibleContent(['dev.normal'], true, cfg)).toBe(false);
  });
  it('rejects malformed policies instead of weakening filters', () => {
    const cfg = defaultConfig();
    for (const rules of [[], { 'dev.app': 'keyword-guess' }, { '': 'off' }, JSON.parse('{"__proto__":"content"}')]) expect(() => normalizeAppCollectionRules(rules)).toThrow();
    expect(() => updateConfig(cfg, { ...cfg, defaultCollection: 'invalid' } as never)).toThrow();
  });
  it('allows desktop or unknown windows under an unrestricted default while preserving explicit restrictions', () => {
    const cfg = defaultConfig();
    expect(collectionForApp('com.apple.finder', cfg)).toBe('content');
    expect(collectionForApp(undefined, cfg)).toBe('content');
    expect(collectionForApp('dev.mote.unknown-foreground', cfg)).toBe('content');
    expect(permitsVisibleContent([], true, cfg)).toBe(true);
    expect(permitsVisibleContent([], true, { ...cfg, appCollectionRules: {'dev.private': 'off'} })).toBe(false);
    expect(collectionForApp('dev.mote.unknown-foreground', { ...cfg, appCollectionRules: { 'dev.private': 'activity' } })).toBe('off');
    expect(collectionForApp('com.apple.finder', { ...cfg, appCollectionRules: {'com.apple.finder': 'off'} })).toBe('off');
  });
});
