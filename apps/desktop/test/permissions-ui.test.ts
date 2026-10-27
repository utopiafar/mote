import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { configureLocale } from '@mote/shared/i18n';
import { createPermissionsUi } from '../src/permissions-ui';
import type { PermissionStatus } from '../src/permission-types';

let dom: JSDOM, ui: ReturnType<typeof createPermissionsUi>;
let status: PermissionStatus;
let api: Parameters<typeof createPermissionsUi>[0];
const flush = () => vi.advanceTimersByTimeAsync(0);
const el = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const button = (kind: string) => el<HTMLButtonElement>(`[data-permission-request="${kind}"]`);
beforeEach(() => {
  vi.useFakeTimers(); configureLocale(() => 'zh-CN');
  dom = new JSDOM(readFileSync(new URL('../src/index.html', import.meta.url), 'utf8'));
  vi.stubGlobal('document', dom.window.document); vi.stubGlobal('window', dom.window); vi.stubGlobal('AbortController', dom.window.AbortController);
  status = { screen: 'denied', accessibility: 'granted', calendar: 'not-determined', canDrag: true, appPath: '/Generated/Mote Dev.app', bundleId: 'dev.generated.mote' };
  api = { permissionStatus: vi.fn(async () => ({ ...status })), permissionSettings: vi.fn(async () => {}), requestPermission: vi.fn(async () => {}), restartForPermissions: vi.fn(async () => {}) };
  ui = createPermissionsUi(api);
});
afterEach(() => { ui.dispose(); dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('requests only the selected permission, manages existing grants, and never claims full disk access', async () => {
  ui.show(); await flush();
  expect(api.requestPermission).not.toHaveBeenCalled();
  expect(el('#permission-screen').textContent).toBe('! 未授权');
  expect(el('#permission-calendar').textContent).toBe('! 尚未授权');
  expect(button('accessibility').textContent).toBe('管理权限 ↗');
  expect(el('#permission-drag-help').hidden).toBe(false);
  button('screen').click(); await flush(); expect(api.requestPermission).toHaveBeenCalledWith('screen');
  button('accessibility').click(); await flush(); expect(api.permissionSettings).toHaveBeenCalledWith('accessibility');
  vi.mocked(api.requestPermission).mockImplementationOnce(async () => { status.calendar = 'granted'; });
  button('calendar').click(); await flush();
  expect(el('#permission-calendar').textContent).toBe('✓ 已授权');
  el<HTMLButtonElement>('[data-permission=files]').click(); await flush();
  expect(api.permissionSettings).toHaveBeenCalledWith('files');
  expect(el('#permission-files').textContent).toBe('按所选路径访问');
  expect(el('#permission-files').classList.contains('unknown')).toBe(true);
  expect(el('#permission-identity').textContent).toContain(status.appPath);
  el<HTMLButtonElement>('#permission-restart').click(); await flush(); expect(api.restartForPermissions).toHaveBeenCalledOnce();
});

it('automatically reflects revocation, coalesces checks, and rejects responses from a page that was left', async () => {
  ui.show(); await flush(); status.accessibility = 'denied';
  await vi.advanceTimersByTimeAsync(1500);
  expect(el('#permission-accessibility').textContent).toBe('! 未授权');
  let finish!: (value: PermissionStatus) => void;
  vi.mocked(api.permissionStatus).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  el<HTMLButtonElement>('#permissions-refresh').click();
  const calls = vi.mocked(api.permissionStatus).mock.calls.length;
  window.dispatchEvent(new dom.window.Event('focus')); await vi.advanceTimersByTimeAsync(4500);
  expect(api.permissionStatus).toHaveBeenCalledTimes(calls);
  ui.hide(); ui.show(); await flush();
  finish({ ...status, screen: 'granted', accessibility: 'granted' }); await flush();
  expect(el('#permission-screen').textContent).toBe('! 未授权');
  ui.hide(); const hiddenCalls = vi.mocked(api.permissionStatus).mock.calls.length;
  await vi.advanceTimersByTimeAsync(4500); window.dispatchEvent(new dom.window.Event('focus')); await flush();
  expect(api.permissionStatus).toHaveBeenCalledTimes(hiddenCalls);
});

it('does not repeat a pending authorization and keeps failures visible through automatic checks', async () => {
  ui.show(); await flush();
  let reject!: (error: Error) => void;
  vi.mocked(api.requestPermission).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  button('calendar').click(); button('calendar').click(); await vi.advanceTimersByTimeAsync(1500);
  expect(api.requestPermission).toHaveBeenCalledOnce(); expect(button('calendar').disabled).toBe(true);
  reject(new Error('Generated unavailable native helper')); await flush();
  expect(button('calendar').disabled).toBe(false);
  expect(el('#permissions-error').textContent).toBe('无法打开权限授权，请重试。');
  await vi.advanceTimersByTimeAsync(1500);
  expect(el('#permissions-error').textContent).toBe('无法打开权限授权，请重试。');
  expect(el('#permission-calendar').textContent).toBe('! 尚未授权');
  el<HTMLButtonElement>('[data-permission=calendar]').click(); await flush();
  expect(api.permissionSettings).toHaveBeenCalledWith('calendar'); expect(el('#permissions-error').textContent).toBe('');
});

it('replaces stale granted badges with unknown when a native check fails, then recovers', async () => {
  ui.show(); await flush();
  vi.mocked(api.permissionStatus).mockRejectedValueOnce(new Error('Generated status failure'));
  await vi.advanceTimersByTimeAsync(1500);
  expect(el('#permission-accessibility').classList.contains('unknown')).toBe(true);
  expect(el('#permissions-error').textContent).toBe('权限状态读取失败，请重试。');
  await vi.advanceTimersByTimeAsync(1500);
  expect(el('#permission-accessibility').classList.contains('granted')).toBe(true);
  expect(el('#permissions-error').textContent).toBe('');
});

it('disables unsupported grants, provides no drag claim for unpackaged runs, and disposes all listeners', async () => {
  status = { screen: 'unsupported', accessibility: 'unsupported', calendar: 'unsupported', canDrag: false };
  ui.show(); await flush();
  expect(button('screen').disabled).toBe(true); expect(button('calendar').disabled).toBe(true);
  expect(el('#permission-drag-help').hidden).toBe(true);
  ui.dispose(); const calls = vi.mocked(api.permissionStatus).mock.calls.length;
  el<HTMLButtonElement>('#permissions-refresh').click(); window.dispatchEvent(new dom.window.Event('focus'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.permissionStatus).toHaveBeenCalledTimes(calls); expect(api.requestPermission).not.toHaveBeenCalled();
});
