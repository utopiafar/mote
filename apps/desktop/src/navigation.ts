export const desktopSections = ['sources', 'permissions', 'work', 'storage', 'records'] as const;
export type DesktopSection = typeof desktopSections[number];
export const desktopPages = [...desktopSections, 'restore', 'export-result', 'mac-options', 'preferences', 'backup', 'chrome', 'source-detail', 'source-editor', 'source-connect', 'content-reader', 'screen', 'meeting', 'statistics', 'notes', 'uploads', 'settings', 'capture-sync', 'connection', 'sync', 'capture', 'privacy', 'developer', 'about', 'activity', 'compression'] as const;
export type DesktopPage = typeof desktopPages[number];

const roots = new Set<DesktopPage>(desktopSections);

export function restoreDesktopSection(remembered: string | null): DesktopSection {
  return desktopSections.find(section => section === remembered) ?? desktopSections[0];
}

/** UI routes only. Captured content never influences navigation or authorization. */
export class DesktopNavigation {
  page: DesktopPage = desktopSections[0];
  section: DesktopSection = desktopSections[0];
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
    }
    this.page = next;
    return true;
  }
}

export function needsCollectionSetup(value: { reviewed: boolean; running: boolean; hasCapture: boolean; queuedRecords: number; recoveryRequired: boolean }): boolean {
  return !value.reviewed && !value.running && !value.hasCapture && value.queuedRecords === 0 && !value.recoveryRequired;
}
