import { describe, expect, it, vi } from 'vitest';
import { DesktopNavigation, desktopPages, needsCollectionSetup, restoreDesktopSection } from '../src/navigation';

describe('desktop local window navigation', () => {
  it('starts in Sources and returns from its screen controls', () => {
    const navigation = new DesktopNavigation();
    expect(navigation.page).toBe('sources');
    expect(navigation.section).toBe('sources');
    expect(navigation.canGoBack).toBe(false);
    navigation.navigate('screen');
    expect(navigation.backTarget).toBe('sources');
    navigation.navigate(navigation.backTarget);
    expect(navigation.page).toBe('sources');
    expect(navigation.backTarget).toBe('sources');
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
    expect(navigation.section).toBe('sources');
    expect(navigation.backTarget).toBe('settings');
    navigation.navigate('notes', () => true);
    expect(navigation.backTarget).toBe('privacy');
  });

  it('returns to Send from the connection and its destination settings', () => {
    const navigation = new DesktopNavigation();
    navigation.navigate('work');
    navigation.navigate('connection');
    expect(navigation.section).toBe('work');
    expect(navigation.backTarget).toBe('work');
    navigation.navigate(navigation.backTarget);
    expect(navigation.page).toBe('work');
  });

  it('restores a saved local section and falls back to Sources for a removed page', () => {
    for (const page of ['permissions', 'work', 'storage', 'records']) {
      expect(restoreDesktopSection(page)).toBe(page);
    }
    for (const page of [null, 'overview', 'ask', 'unknown']) {
      expect(restoreDesktopSection(page)).toBe('sources');
    }
    expect(desktopPages).not.toContain('overview');
    expect(desktopPages).not.toContain('ask');
  });
});

it('offers a first collection setup without requiring a central connection, and keeps recovery controls reachable', () => {
  const fresh = { reviewed: false, running: false, hasCapture: false, queuedRecords: 0, recoveryRequired: false };
  expect(needsCollectionSetup(fresh)).toBe(true);
  for (const changed of [{ reviewed: true }, { running: true }, { hasCapture: true }, { queuedRecords: 1 }, { recoveryRequired: true }]) {
    expect(needsCollectionSetup({ ...fresh, ...changed })).toBe(false);
  }
});

it('returns to the section that opened delivery details', () => {
  const navigation=new DesktopNavigation();
  for (const section of ['sources', 'records', 'work'] as const) {
    navigation.navigate(section);
    navigation.navigate('uploads');
    expect(navigation.section).toBe(section);
    expect(navigation.backTarget).toBe(section);
  }
});
