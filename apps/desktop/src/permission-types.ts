import type { PermissionKind } from './contracts/permissions';
export type { PermissionKind, DragPermissionKind, PermissionStatus } from './contracts/permissions';
const permissionSettingsPanes: Record<PermissionKind,string> = {screen:'Privacy_ScreenCapture',accessibility:'Privacy_Accessibility',calendar:'Privacy_Calendars',files:'Privacy_AllFiles'};
export function permissionSettingsUrl(kind: PermissionKind):string {
  return 'x-apple.systempreferences:com.apple.preference.security?' + permissionSettingsPanes[kind];
}
export function permissionKind(value: unknown): PermissionKind {
  if (value !== 'screen' && value !== 'accessibility' && value !== 'calendar' && value !== 'files') throw new Error('Unknown permission');
  return value;
}
export interface SettingsWindow {
  frontmost: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface PermissionHelpState {
  locale: string;
  title: string;
  appName: string;
  icon: string;
  drag: string;
  existing: string;
  note: string;
  reveal: string;
  close: string;
}
