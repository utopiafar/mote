import { describe, expect, it, vi } from 'vitest';
import { DesktopNavigation, needsCollectionSetup } from '../src/navigation';

describe('desktop library navigation', () => {
  it('keeps collection controls under collection and returns through the actual source path', () => {
    const navigation = new DesktopNavigation();
    navigation.navigate('sources');
    expect(navigation.section).toBe('overview');
    expect(navigation.backTarget).toBe('overview');
    navigation.navigate('permissions');
    expect(navigation.backTarget).toBe('sources');
    navigation.navigate(navigation.backTarget);
    expect(navigation.page).toBe('sources');
    expect(navigation.backTarget).toBe('overview');
  });

  it('returns a note to its originating page without changing the selected main section', () => {
    const navigation = new DesktopNavigation();
    navigation.navigate('records');
    navigation.navigate('notes');
    expect(navigation.section).toBe('records');
    expect(navigation.backTarget).toBe('records');
    navigation.navigate(navigation.backTarget);
    expect(navigation.page).toBe('records');
    expect(navigation.canGoBack).toBe(false);
  });

  it('keeps settings-origin controls in Settings and rejects a route without discarding its return path', () => {
    const navigation = new DesktopNavigation();
    navigation.navigate('settings');
    navigation.navigate('privacy');
    const discard = vi.fn(() => false);
    expect(navigation.navigate('notes', discard)).toBe(false);
    expect(discard).toHaveBeenCalledOnce();
    expect(navigation.page).toBe('privacy');
    expect(navigation.section).toBe('settings');
    expect(navigation.backTarget).toBe('settings');
    navigation.navigate('notes', () => true);
    expect(navigation.backTarget).toBe('privacy');
  });

  it('keeps advanced pages in Settings and preserves an active question when connection is needed', () => {
    const navigation = new DesktopNavigation();
    navigation.navigate('activity');
    expect(navigation.section).toBe('settings');
    navigation.navigate('ask');
    navigation.navigate('connection');
    expect(navigation.section).toBe('overview');
    expect(navigation.backTarget).toBe('ask');
    navigation.navigate(navigation.backTarget);
    expect(navigation.section).toBe('ask');
  });
});

it('offers a first collection setup without requiring a central connection, and keeps recovery controls reachable', () => {
  const fresh = { reviewed: false, running: false, hasCapture: false, queuedRecords: 0, recoveryRequired: false };
  expect(needsCollectionSetup(fresh)).toBe(true);
  for (const changed of [{ reviewed: true }, { running: true }, { hasCapture: true }, { queuedRecords: 1 }, { recoveryRequired: true }]) {
    expect(needsCollectionSetup({ ...fresh, ...changed })).toBe(false);
  }
});
