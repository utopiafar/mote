export const desktopPages = ['restore','export-result','mac-options','preferences','backup','storage','chrome','source-detail','source-editor','source-connect','content-reader', 'screen', 'meeting', 'ask', 'statistics', 'overview', 'notes', 'records', 'uploads', 'sources', 'work', 'settings', 'capture-sync', 'connection', 'sync', 'capture', 'privacy', 'developer', 'about', 'activity', 'compression', 'permissions'] as const;
export type DesktopPage = typeof desktopPages[number];
export type DesktopSection = 'overview' | 'records' | 'ask' | 'sources' | 'work' | 'settings';

const roots = new Set<DesktopPage>(['overview', 'records', 'ask', 'sources', 'work', 'settings']);
const advanced = new Set<DesktopPage>(['mac-options','preferences','backup','storage','chrome','capture-sync','statistics', 'activity', 'developer', 'about', 'compression']);

/** UI routes only. Captured content never influences navigation or authorization. */
export class DesktopNavigation {
  page: DesktopPage = 'overview';
  section: DesktopSection = 'overview';
  private trail: DesktopPage[] = [];

  get backTarget(): DesktopPage { return this.trail.at(-1) ?? this.section; }
  get canGoBack(): boolean { return !roots.has(this.page); }

  navigate(next: DesktopPage, mayLeave: () => boolean = () => true): boolean {
    if (next === this.page) return true;
    if (!mayLeave()) return false;
    if (roots.has(next)) {
      this.section = next as DesktopSection;
      this.trail = [];
    } else {
      if (this.trail.at(-1) === next) this.trail.pop();
      else this.trail.push(this.page);
      if (advanced.has(next)) this.section = 'settings';
    }
    this.page = next;
    return true;
  }
}

export function needsCollectionSetup(value: { reviewed: boolean; running: boolean; hasCapture: boolean; queuedRecords: number; recoveryRequired: boolean }): boolean {
  return !value.reviewed && !value.running && !value.hasCapture && value.queuedRecords === 0 && !value.recoveryRequired;
}
