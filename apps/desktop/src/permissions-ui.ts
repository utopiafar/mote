import { moteText } from '@mote/shared/i18n';
import type { DesktopApi } from './contracts';
import type { PermissionKind, PermissionStatus } from './permission-types';

export function createPermissionsUi(api: Pick<DesktopApi, 'permissionStatus' | 'permissionSettings' | 'requestPermission' | 'restartForPermissions'>) {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const root = document.querySelector<HTMLElement>('[data-page="permissions"]')!;
  const controller = new AbortController();
  const pending = new Set<PermissionKind>();
  let active = false, disposed = false, generation = 0;
  let status: PermissionStatus | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking: Promise<void> | undefined;
  let actionError = '', checkError = '';
  const renderError = () => { byId('permissions-error').textContent = actionError || checkError; };

  const render = () => {
    const labels: Record<string, string> = {
      granted: moteText('已授权'), denied: moteText('未授权'), restricted: moteText('系统限制'),
      'not-determined': moteText('尚未授权'), unsupported: moteText('当前平台不支持'), unknown: moteText('无法确认，请检查系统设置'),
    };
    for (const kind of ['screen', 'accessibility', 'calendar'] as const) {
      const value = status?.[kind] ?? 'unknown';
      const granted = value === 'granted', unknown = !['granted', 'denied', 'restricted', 'not-determined'].includes(value);
      const badge = byId('permission-' + kind);
      badge.className = 'permission-badge ' + (granted ? 'granted' : unknown ? 'unknown' : 'denied');
      badge.textContent = (granted ? '✓ ' : unknown ? '? ' : '! ') + (labels[value] ?? labels.unknown);
      const button = root.querySelector<HTMLButtonElement>(`[data-permission-request="${kind}"]`)!;
      button.textContent = pending.has(kind) ? moteText('正在打开…') : granted ? moteText('管理权限 ↗') : kind === 'calendar' ? moteText('授权日历') : moteText('前往授权 ↗');
    }
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-permission-request], [data-permission]'))) {
      const kind = (button.dataset.permissionRequest ?? button.dataset.permission) as PermissionKind;
      button.disabled = pending.has(kind) || (kind === 'files' ? status?.screen === 'unsupported' : status?.[kind] === 'unsupported');
    }
    byId('permission-drag-help').hidden = status?.canDrag !== true;
    byId('permission-identity').textContent = `${status?.bundleId ?? ''}\n${status?.appPath ?? ''}`.trim();
  };
  const refresh = (): Promise<void> => {
    if (!active || disposed) return Promise.resolve();
    if (checking) return checking;
    const revision = generation;
    const task = api.permissionStatus().then(next => {
      if (!active || disposed || revision !== generation) return;
      status = next; render(); checkError = ''; renderError();
    }).catch(() => {
      if (!active || disposed || revision !== generation) return;
      status = undefined; render(); checkError = moteText('权限状态读取失败，请重试。'); renderError();
    }).finally(() => { if (checking === task) checking = undefined; });
    checking = task;
    return task;
  };
  const act = async (kind: PermissionKind, settingsOnly: boolean) => {
    if (pending.has(kind) || disposed) return;
    pending.add(kind); render(); actionError = ''; renderError();
    let failed = false;
    try {
      if (settingsOnly || (kind !== 'files' && status?.[kind] === 'granted')) await api.permissionSettings(kind);
      else await api.requestPermission(kind);
    } catch { failed = true; }
    finally {
      pending.delete(kind);
      if (active && !disposed) { render(); await refresh(); if (failed) { actionError = moteText('无法打开权限授权，请重试。'); renderError(); } }
    }
  };
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-permission-request], [data-permission]'))) {
    const kind = (button.dataset.permissionRequest ?? button.dataset.permission) as PermissionKind;
    button.addEventListener('click', () => void act(kind, Boolean(button.dataset.permission)), { signal: controller.signal });
  }
  byId('permissions-refresh').addEventListener('click', () => void refresh(), { signal: controller.signal });
  byId('permission-restart').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('permission-restart'); button.disabled = true;
    try { await api.restartForPermissions(); }
    catch { actionError = moteText('重新启动失败，请完全退出 Mote 后重新打开。'); renderError(); }
    finally { button.disabled = false; }
  }, { signal: controller.signal });
  window.addEventListener('focus', () => void refresh(), { signal: controller.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); }, { signal: controller.signal });
  const hide = () => { active = false; generation++; checking = undefined; clearInterval(timer); timer = undefined; };
  return {
    show() { if (disposed) return; if (!active) { active = true; timer = setInterval(() => void refresh(), 1500); } void refresh(); },
    hide,
    dispose() { disposed = true; hide(); controller.abort(); },
  };
}
